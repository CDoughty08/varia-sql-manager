# IPC protocol v2

How the Electron main process, the .NET backend, and the renderer's results worker talk: frames, the MessagePack subset,
the handshake, requests and streams, result pages, the result store, the results port, restarts, limits, error codes,
SSMS display formats, and benchmarks. The code is the reference implementation; this document describes it.

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
| Copy and Save Results As | `src/main/results-jobs.ts`; TypeScript twin `src/shared/results/text-writer.ts` (local tables, fake backend) | `Results/ResultJobs.cs`, `ResultTextWriter.cs`, `PageView.cs` |
| Results worker | `src/renderer/src/results/` | — |
| Live subscriptions | `src/shared/live/` (catalogue, schemas, docs/live.md); main's parts in `connection.ts`, `supervisor.ts`, `results-port.ts`; `LiveService` in `src/renderer/src/live/` | `Live/` (`LiveService.cs` registry and scheduler, `LiveCatalog.cs`, `SqlSampler.cs`, `LiveSql.cs`, `LiveSqlReader.cs`, `LiveTables.cs`, `LiveStart.cs`, `LiveDeltas.cs`, `LiveGates.cs`, `LiveResume.cs`, `LiveErrors.cs`, `SyntheticSampler.cs`), `Activity/ActivityReader.cs`, `ActivityRows.cs` |

## Contents

- [Shape](#shape)
- [Frames](#frames)
- [MessagePack subset](#messagepack-subset)
- [Handshake](#handshake)
- [Requests, deadlines, and cancellation](#requests-deadlines-and-cancellation)
- [Methods](#methods)
- [Providers](#providers)
- [Streams and credits](#streams-and-credits)
- [Execution plan viewer](#execution-plan-viewer)
- [Query execution](#query-execution)
- [Query events](#query-events)
- [Result pages](#result-pages)
- [Result store and memory budget](#result-store-and-memory-budget)
- [Remote results](#remote-results)
- [Cell lengths and row sizes](#cell-lengths-and-row-sizes)
- [Messages](#messages)
- [Sorted views](#sorted-views)
- [Row identities and highlights](#row-identities-and-highlights)
- [Result diffs](#result-diffs)
- [Pivots](#pivots)
- [Transposed](#transposed)
- [Search in results](#search-in-results)
- [Column profiles](#column-profiles)
- [Distinct values](#distinct-values)
- [Copy and Save Results As](#copy-and-save-results-as)
- [Live subscriptions](#live-subscriptions)
- [Results port and results worker](#results-port-and-results-worker)
- [Malformed input](#malformed-input)
- [Backend threads and exit codes](#backend-threads-and-exit-codes)
- [Generations, restarts, and lost connections](#generations-restarts-and-lost-connections)
- [Limits](#limits)
- [Connection ownership and binding updates](#connection-ownership-and-binding-updates)
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

- **Unary methods** use `ipcRenderer.invoke('varia:request')`: `trusted()`, strict zod (`requestSchemas`), and `ApiResult`
  results with an error `code`.
- **Connect context.** `connections.connect` and `.databases` take an optional fourth argument, a strict `ConnectContext`:
  history `profileId`, `remember`, `requestId` (for Stop), optional durable `targetId`, `setsEnvironment`, the target's
  `expectedPrincipal` and exact opaque `credential` revision, `credentialIntent` (`preserve` or `update-credentials`) and
  `credentialPolicy` (`preserve`, `remember` or `forget`). Any other method with a context fails `Invalid request.`.
  - `mode: 'background'` requires the prior principal, exact revisions for password authentication and preservation; it
    cannot carry a Remember choice or a typed password. Main injects backend-only `nonInteractive` (15 s wire and
    provider budget) and never starts a browser sign-in.
  - Main returns `ConnectionInfo.authentication` only from the actual server login, validates the expected account
    before saving anything, and disposes a mismatched handle.
  - An injected saved-binding login refusal carries `credentialRejected: true`; successful forgetting adds
    `passwordForgotten: true`. SQL 18456 states 2, 5 and 8 are credential rejection; ambiguous state 1 suppresses queued
    replays but keeps ciphertext. Grant failures and unavailable databases neither suppress other targets nor erase
    secrets. Entra rejection is AADSTS50126 or 7000215 only.
  - Main's bounded `ConnectionAuthenticationGuard` keeps nonsecret authentication pins independently of checkpoint
    acknowledgement. Disk restore seeds them; hot-exit/reload snapshots project options, principal and credential
    references from the pins, so a forged snapshot cannot redirect an established target. The reuse owner calls
    `forget(targetId)` only after pruning a target without documents, transports or attempts.
  - Main bounds preparation and transport together before the first await (keyring/gate waits included); target and
    credential-binding leases stay held through authentication, history and credential revision receipts.
- **One MessagePort per renderer load** carries query events, the memory push, and the `results.read` / `results.close`
  streams between main and the results worker. The preload never decodes MessagePack and exposes no port.
- **Rows stay in the backend.** `query.execute` returns a summary with a descriptor per result set; the worker reads
  pages on demand. Reading from SQL Server never waits for the UI.
- **Main never decodes pages.** It checks each DATA frame's header, stream, sequence and credit, copies the body into an
  exact-size `ArrayBuffer` (Electron cannot transfer one from main to a renderer) and posts it to the worker; inside the
  renderer, windows are transferred.
- **The supervisor restarts the process, never sessions.** A request belongs to one generation and is never re-sent;
  connections of an ended generation show as lost until the user reconnects.

## Frames

Every frame is a 16-byte little-endian header followed by its body.

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
| 4 | EVENT | backend → main | id of a `query.execute` request: a [query event](#query-events). id 0: `{ type: 'results.memory' or 'explorer.index.memory', usedBytes, globalBytes, seq, detail }` ([Global memory events](#global-memory-events)) |
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

**Parsing.** `FrameParser` (TypeScript) validates magic, kind, direction, flags and length before allocating, then copies
the body into its own exact-length `Uint8Array` (never pooled). An oversize body is skipped and reported, so the stream
stays in sync; any other violation leaves the parser dead. The backend's `FrameReader` reads the header with
`ReadExactly`, validates it, and reads the body into a new array; an oversized REQUEST body is drained through a 64 KiB
scratch buffer and answered `TOO_LARGE`.

**Writing.** Main writes one exact buffer per frame (`encodeFrame`) and bounds its queued stdin at 32 MiB. The backend's
`Outbound` writer drains a control lane before a bulk lane through a 64 KiB buffer, flushing when both are empty; bodies
over 64 KiB, and stored pages, go straight through without copying.

## MessagePack subset

Both sides hand-roll the same subset (no dependency): nil, false, true; positive and negative fixint, uint8 – 64, int8 –
64; float64 (`cb`); fixstr, str8/16/32; bin8/16/32 (page bodies only); fixarray, array16/32; fixmap, map16/32. `c1`,
float32 and every ext type are rejected.

**Canonical encoding.** Always the smallest form, unsigned for non-negative integers; a JavaScript number is an integer
when `Number.isSafeInteger` holds, else float64; `-0` is written as 0. `undefined` properties are omitted; `undefined` in
an array is an error. The C# writer produces identical bytes (`tests/fixtures/ipc-vectors.json`).

**Decoding control bodies** (`decodeControl`, `MsgPackReader` with `JsonBridge`):

- JSON-shaped only: string keys, no bin, no duplicate keys, no `__proto__`, `constructor` or `prototype` keys.
- Strict UTF-8 (overlong forms, surrogates, truncated sequences rejected); NaN and ±Infinity rejected; float64 `-0`
  decodes as 0.
- Integers of any width, range-checked to ±(2⁵³ − 1).
- Depth ≤ 16 (tracked without recursion), maps ≤ 4,096 entries, arrays ≤ 1,048,576 items, keys ≤ 128 bytes, every
  length checked against the remaining bytes before allocating. The whole body must be consumed.

The backend transcodes REQUEST params to a `JsonElement` and results from System.Text.Json output (`JsonBridge`), so STJ
records with `UnmappedMemberHandling.Disallow` still reject unknown members; JSON integers beyond ±(2⁵³ − 1) become
float64. **Sensitive requests** (`connections.connect`, `.databases`, `.preview`, `ssis.execute` with Create Catalog's
encryption password, `actions.execute` whose `secrets` carries New Login's password; `actions.script` refuses `secrets`
in main and the backend) are encoded into buffers zeroed after use on both sides (the source strings cannot be zeroed).
Main zeroes methods whose `methodPolicies` entry is `sensitive`, the backend those in `SqlService.SensitiveMethods`
(`IRequestDispatcher.Sensitive`); `tests/validation.test.ts` keeps the lists equal.

## Handshake

1. Main spawns the backend (stdio pipes, `windowsHide`) and writes HELLO
   `{ versions: [2, 2], generation, maxFrameBytes: 16777216, app }`; nothing else until HELLO completes.
2. The backend opens stdout, redirects `Console.Out` to stderr, empties `Console.In`, installs an unhandled-exception
   handler (best-effort GOAWAY `BACKEND_CRASH`, exit 70), and waits for HELLO. Any other frame first, or no HELLO within
   20 s: GOAWAY `PROTOCOL_ERROR`, exit 64. No common version: GOAWAY `PROTOCOL_UNSUPPORTED` with `versions: [2, 2]`,
   exit 65.
3. The backend answers HELLO
   `{ version: 2, generation, pid, runtime, platform, sqlClientVersion, maxFrameBytes: 4194304, resultBudget: { globalBytes, queryBytes }, methods }`
   without loading SMO (`system.health` still reports its version).
4. Main validates it with zod: version 2, the echoed generation, `maxFrameBytes` ≥ 4 MiB, and `methods` containing every
   method main may call (`backendMethods`). Any failure is `failed (incompatible)` with no retry, which catches a stale
   build after C# changes.
5. A protocol 1 backend reads lines and answers the line `V` at once with JSON, so a first stdout byte of `{` is reported
   as incompatible within milliseconds.

## Requests, deadlines, and cancellation

- **Envelope.** `{ method, params, credit? }`. The reader thread validates only the envelope; params are transcoded and
  checked on the dispatched task (`INVALID_PARAMS` is not fatal).
- **Exactly one RESPONSE per REQUEST id**, including streams, cancellations and deadlines (an interlocked settle flag on
  the backend; a pending table on main).
- **Deadlines.** The header deadline is linked to the request's cancellation token. If the deadline passes and the work does not
  stop, the backend answers `TIMEOUT` within 100 ms, discards the late result, and frees the metadata slot only when the work ends
  (SMO cannot be interrupted). `query.execute` sends no header deadline; the script's own timeout ends with `timedOut`.
- **Main's backstop** fires 5 s after the header deadline (`query.execute`: `timeoutSeconds + 30` s, none for timeout 0).
  It yields one `setImmediate` turn (the answer may already be in the pipe); if still pending it fails with `TIMEOUT`,
  sends CANCEL reason 2, and adds the id to a 4,096-entry ring of abandoned ids whose late frames are dropped and counted.
- **CANCEL** for an unknown or finished id is ignored. Otherwise the token is cancelled: reason 1 ends `query.execute` as
  `cancelled`, unary methods answer `CANCELLED`, and `results.read` answers `CANCELLED` after its current page.
- **Ordering.** Unary RESPONSEs and all EVENTs use the control lane, so a query's events precede its summary. A stream's
  DATA frames and final RESPONSE use the bulk lane, in order. Between the invoke and port channels, the summary is
  authoritative.
- **Ids** are u32 from 1 per generation and stay below 2³¹; reaching that ends the generation.

## Methods

`methodPolicies` (`src/shared/ipc/methods.ts`) gives each method its kind, lane and deadline. Lanes decide how the
backend schedules it:

| Lane | Scheduling |
| --- | --- |
| `control` | At once. |
| `metadata` | One of 8 slots, waited for at most 30 s or the remaining deadline, then `BUSY`. |
| `query` | The per-tab session path. |
| `results` | One of 16 read slots, waited for at most 30 s or the remaining deadline, then `BUSY`. |
| `explorer` | At once, under Object Explorer's gates (4 statements per connection, 8 in all; static folders need neither). |
| `actions` | At once, under the action service's gates: execute 1 per Varia connection, 2 in all; long actions (restore, backup) a separate long gate, also 1 and 2; each waited for at most 30 s, then `BUSY`. `activity.kill` has its own gates (1 and 2, waited for at most 5 s, then `BUSY`), so it never queues behind a DROP waiting on the session it kills. A DROP waiting on a lock never holds a metadata slot. |
| `live` | No slot. A subscription samples on its own task; its statements and unary `live` methods (`activity.details`, via `LiveService.RunGatedAsync`) run under the live gates (2 per connection, 8 in all, waited for at most the statement's budget, Details' 10 s, then `BUSY`; an unconnected id is `NOT_CONNECTED`). |
| `ssis` | At once, under the SSIS gates (reads 2 per connection and 4 in all, writes 1 and 2, waited for at most 30 s, then `BUSY`). |

In the table, "budget N s" means the backend stops its own work after N s and answers an `error: TIMEOUT` value inside
the header deadline. Two rows differ: `plans.estimate`'s 30 s bounds the whole acquisition (connection and
compilation; its gate never waits), past which the request fails with error code `TIMEOUT`; `explorer.index`'s 120 s per database (it has no
header deadline) skips that database with status `TIMEOUT` and indexing goes on. "Sensitive" means the frame is zeroed after use; "never re-sent" applies to every method but is
noted where it matters.

| Method | Renderer path | Kind | Lane | Header deadline and notes |
| --- | --- | --- | --- | --- |
| `system.health` | invoke | unary | control | 10 s |
| `connections.connect` | invoke; Stop via `cancelConnectionRequests` | unary | metadata | SQL Server: (connect timeout, default 15) + 30 s, + 180 s for Entra MFA's browser sign-in; 0 means none. BigQuery: 45 s (15 s non-interactive). Sensitive. Takes either engine's options. A failed open carries error `details`. |
| `connections.databases` | invoke; `cancelConnectionRequests` | unary | metadata | 45 s, + 180 s for Entra MFA. Sensitive. Failed open carries `details`. BigQuery: the project's datasets with `location?` ([BigQuery](bigquery.md#datasets)); main adds `credential`. |
| `connections.discover` | invoke | unary | metadata | 45 s |
| `connections.preview` | invoke | unary | metadata | 10 s. Sensitive. |
| `connections.disconnect` | invoke | unary | control | 30 s; answered locally `{ disconnected: false }` for a lost connection or failed backend |
| `connections.identity` | invoke | unary | metadata | 10 s. Takes `{}` (**Integrated identity** below). |
| `bigquery.account`, `bigquery.projects` | invoke | unary | control | 30 s, sensitive. BigQuery before connecting: `{ authentication, keyFile?, impersonateServiceAccount? }` (`.projects` adds `pageToken?` ≤ 1,024). Main adds `credential` (`{ source: 'file' \| 'adc' \| 'metadata' \| 'anonymous', json? ≤ 64 KiB }`), which the renderer never holds. Answers `{ kind, account ≤ 256, impersonated? }` and `{ projects: { id, friendlyName? ≤ 256 }[] ≤ 1,000, nextPageToken? }` ([BigQuery](bigquery.md#pre-connect-methods)). |
| `bigquery.dryRun` | invoke | unary | metadata | 30 s. A free dry run on a connected BigQuery handle: `{ connectionId, sql ≤ 1,000,000, dataset? ≤ 1,024 }`. Answers `{ bytesProcessed, incomplete?: 'script' \| 'lowerBound' \| 'unknown' \| 'zeroBytes', statementType?, faked? }`; a query BigQuery refuses is `SQL_ERROR` with its `[line:column]` ([BigQuery's Cost](bigquery.md#cost)) |
| `databases.list` | invoke | unary | metadata | 45 s; for a BigQuery handle, the billing project's datasets |
| `tables.columns` | invoke | unary | metadata | 45 s; the backend stops its own query after 30 s, answering with an envelope error (`TIMEOUT`, or `SQL_ERROR` when SqlClient reports the cancel), not a result `error` value. Tables and views, read through `QUOTENAME(@db) + '.sys.sp_executesql'` so no pooled connection stays in the database |
| `language.status`, `language.close` | invoke | unary | control | 10 s |
| `language.complete`, `language.hover`, `language.diagnostics` | invoke | unary | metadata | 30 s |
| `language.refresh` | invoke | unary | control | 30 s; on the control lane so it can cancel stale language work while the metadata slots are full |
| `language.definition` | invoke (F12, Alt+F12, Ctrl+hover, Ctrl+click) | unary | metadata | 15 s, budget 10 s. Takes a `language.complete` request; answers `null` or `{ database, schema, name, kind, subtype?, range }`, read on the Object Explorer pool with constant `DefinitionSql.Lookup` (names as parameters, cross-database through `QUOTENAME(@db) + '.sys.sp_executesql'`) |
| `plans.parse` | invoke | unary | metadata | 15 s; parses Showplan only, no SQL connection. Main compresses raw XML before the 4 MiB request bound ([Execution plan viewer](#execution-plan-viewer)) |
| `plans.estimate` | invoke | unary | query | 35 s; 30 s acquisition budget (connection and compilation; a full gate of 2 answers `BUSY` at once); `mode: isolated \| session` (default isolated), two acquisitions, 64 documents / 2,097,152 XML characters in total; cancelled by `query.cancel(requestId)`; no query events or summary fields ([estimated plans](execution-plans.md#estimated-plans)) |
| `query.execute` | invoke, events on the port | unary with EVENTs | query | none; backstop `timeoutSeconds + 30` s |
| `query.cancel` | invoke | unary | control | 10 s |
| `results.remoteQuery` | invoke, events on the port | unary with EVENTs | query | none; BigQuery only; Stop is `query.cancel` ([Remote results](#remote-results)) |
| `query.session.close` | invoke | unary | control | 30 s, 60 s with `transaction: 'commit'` (a BigQuery close waits for a stopped job and ends the session within them); answered locally `{ closed: false }` for an ended generation or with no backend |
| `query.session.state` | invoke | unary | control | 5 s; answered locally `SESSION_LOST` for an ended generation or with no backend |
| `results.visibility` | invoke (`ResultVisibilityService`) | unary | control | 10 s (note 1 below) |
| `results.read` | port | stream | results | 60 s |
| `results.close` | port | unary | control | 10 s |
| `results.rowBytes` | port | unary | control | 10 s; 1 – 16,384 sealed rows ([Cell lengths and row sizes](#cell-lengths-and-row-sizes)) |
| `results.view` | port | unary | results | 120 s ([Sorted views](#sorted-views)) |
| `results.viewClose` | port | unary | control | 10 s |
| `results.identify` | port | unary | results | 120 s ([Row identities and highlights](#row-identities-and-highlights)) |
| `results.rowIds` | port | unary | control | 10 s; 1 – 16,384 rows |
| `results.findRows` | port | unary | results | 60 s; 1 – 10,000 identities in a result or view |
| `results.diff` | port | unary | results | 120 s; stored as a new result, two rows a change or one row an entry, optionally replacing an earlier comparison under its allowance ([Result diffs](#result-diffs)) |
| `results.diffSeek` | port | unary | results | 10 s; the next or previous change, or a look-alike's partner, in a comparison or its view ([Result diffs](#result-diffs)) |
| `results.search` | port | unary | results | 120 s ([Search in results](#search-in-results)) |
| `results.pivot` | port | unary | results | 120 s; stored as a new result ([Pivots](#pivots)) |
| `results.profile` | port | unary | results | 120 s ([Column profiles](#column-profiles)) |
| `results.distinct` | port | unary | results | 120 s; a snapshot of a column's distinct values ([Distinct values](#distinct-values)) |
| `results.distinctRead` | port | unary | results | 30 s; a window of 1 – 512 values, optionally searched |
| `results.distinctTick` | port | unary | results | 30 s; ticks or clears values, all, a search's, ranges of the list, or inverts |
| `results.distinctClose` | port | unary | control | 10 s; releases 1 – 64 snapshots |
| `live.subscribe` | port | stream of credited EVENTs ([Live subscriptions](#live-subscriptions)) | live (no slot) | none, no backstop: only CANCEL, disconnect, shutdown, failure or its source ending ends it |
| `live.update` | port | unary | control | 10 s |
| `explorer.children` | invoke; `explorerCancel` | unary | explorer | 45 s, budget 40 s |
| `explorer.index` | invoke; `explorerCancel` | unary with droppable `explorer.index.progress` EVENTs (relayed to the requesting window, ≤ 4/s) | explorer | none; 120 s budget per database ([Search Objects](object-search.md)) |
| `explorer.search` | invoke; `explorerCancel` | unary | explorer | 15 s; stops at 5 s and answers `partial` |
| `explorer.peek` | invoke; `explorerCancel` | unary | explorer (Peek's slot per connection) | 30 s, budget 15 s from when it has the slot |
| `explorer.peekDependencies` | as `explorer.peek` | unary | as `explorer.peek` | as `explorer.peek` |
| `explorer.dependencies` | as `explorer.peek` | unary: one level, one direction, ≤ `dependencyLimits.perLevel` objects | as `explorer.peek` | as `explorer.peek` |
| `explorer.peekDefinition` | as `explorer.peek` | unary: one page of a module's text, ≤ `peekLimits.definitionPageChars` UTF-16 units, one at a time after `explorer.peek`'s first | as `explorer.peek` | as `explorer.peek` |
| `results.copy` | main only (`varia:results-copy`) | stream, with EVENTs | results | 120 s |
| `results.export` | main only (`varia:results-save`) | unary with EVENTs | results | none, no backstop: only CANCEL (reason 1) |
| `scripting.script` | invoke; `cancelScripting` | unary | metadata | 60 s, budget 55 s |
| `actions.describe` | invoke; `cancelObjectActions` | unary | metadata | 45 s, budget 40 s (reads wait ≤ 10 s for a lock: `BLOCKED`). Server file picker (`dialog: 'serverFiles'`): 15 s around a 10 s budget per listing. Restore Database (`dialog: 'restoreDatabase'`): 130 s around 120 s for reading backup media |
| `actions.script` | invoke; `cancelObjectActions` | unary | metadata | 30 s, budget 25 s |
| `actions.execute` | invoke; `cancelObjectActions` (Stop); progress via `onActionProgress` | unary with EVENTs | actions | none, no backstop (note 2 below). Sensitive. Main checks the answer (`actionExecuteResultSchema`, every step field bounded). Never re-sent |
| `ssis.describe` | invoke; `cancelSsis` | unary | ssis | 45 s, budget 40 s (lock wait ≤ 5 s, role checks 1 s: `BLOCKED`) |
| `ssis.execute` | invoke; `cancelSsis` (Stop) | unary | ssis | none, no backstop: waits for locks as SSMS does; only CANCEL (reason 1) ends it, answered with its steps once SQL Server ends the statement (≤ 10 s later); preflight budget 25 s (lock timeout 10 s: `BLOCKED`). Sensitive. Never re-sent. Create Catalog: see **Create Catalog** below |
| `ssis.catalogSetup` | invoke; `cancelSsis` | unary | ssis | 45 s, budget 40 s (lock timeout 10 s: `BLOCKED`) |
| `activity.details` | invoke; `cancelActivity` (closing Details) | unary | live (live gates) | 15 s, budget 10 s |
| `activity.kill` | invoke | unary | actions (own gates) | 30 s, budget 25 s, answered with the outcomes of the sessions tried. Never re-sent |
| `agent.profile` | invoke | unary: one login's SQL Server Agent facts ([SQL Server Agent](sql-server-agent.md)); SQL Server only | explorer, on its own slot per connection (never behind the tree's paging) | 15 s, budget 10 s from when it has the slot (`agentLimits.profileMs`). Main checks the answer (`agentProfileResultSchema`) |
| `entra.cache.clear` | main only (`varia:entra-cache-clear`, after its confirmation) | unary | control | 10 s. Takes `{}` (unknown members refused); answers `{ cleared: true }` |
| `results.setMemoryLimit` | main only (`ResultMemoryLimit`, `src/main/backend/result-memory.ts`) | unary | control | 10 s (note 3 below) |
| `debug.results.synthesize` | `__variaTest` and tests only | unary | metadata | 120 s; only with `VARIA_BACKEND_TEST_HOOKS=1` |

Notes:

1. `results.visibility { source, seq, visible }`: a UUID per renderer load, a number rising from 1 (≤ 2^31 - 1), and the
   whole set of shown result ids of the current generation (0 to 4,096 distinct u32 ids above 0,
   `limits.visibility.maxResults`; else `INVALID_PARAMS`), replacing the last. Answers `{ visible, applied }`: `visible` is
   how many ids the backend's visible set holds (a count, unlike the request's id array), and `applied` is false for a
   `seq` not above the last applied from that source. Unstored ids are ignored. Sent, one in flight, when the shown set
   changes in any window and again each time the backend becomes ready or the results port's generation changes; once main has
   reported a state, only while it reports the backend ready in the port's generation. A hint for the packer
   ([Result store and memory budget](#result-store-and-memory-budget)): a change wakes it, and a result shown again
   stops packing at its next page.
2. `actions.execute`: only CANCEL (reason 1) ends it, answered with its steps once the statement, compensation and
   cleanup have ended (≤ 10 s + `cleanupMs`). While a long action (catalogue `long`) is pending, main closes its
   generation with a grace of 10 s + `cleanupMs` + 5 s (`drainMs`, `actionDrainMs`); other actions get main's usual grace.
3. `results.setMemoryLimit { limitGiB }`: a whole number 0 (automatic) to 1024 (`resultsMemoryLimitSchema`; else
   `INVALID_PARAMS`); answers `{ applied, globalBytes, queryBytes }`, `applied` false only under the test hooks' fixed
   budget. A changed `results.memory` event precedes the answer or follows within a second. Main sends it, one in flight,
   as each generation becomes ready, when `queryResults.grid.memoryLimitGiB` changes, and after each successful settings
   read (`SettingsStore.onDidLoad`). A failed request is not re-sent: a value set while it was in flight, the generation's
   recovery from unresponsive, the next change or the next launch sends a new one.

`mainOnlyMethods` (`results.copy`, `results.export`, `entra.cache.clear`, `results.setMemoryLimit`,
`debug.results.synthesize`) are sent only by main: they are in no renderer schema (`requestSchemas`) and no port schema
(`portRequestSchema`).

**Microsoft Entra ID.** The six Entra types (`entraMfa`, `entraPassword`, `entraIntegrated`, `entraServicePrincipal`,
`entraManagedIdentity`, `entraDefault`; `src/shared/auth.ts` and `EntraModes.cs` list all eight `authentication` types)
become SqlClient's `Authentication` keyword, so every derived pool gets tokens through Varia's own
`SqlAuthenticationProvider` (registered for SqlClient's seven Entra methods, not device code flow or workload
identity). Tokens stay in backend memory (MSAL in-memory caches, one per authority plus one for Entra Integrated; MSAL's
managed identity cache; Azure.Identity credentials), never on disk or IPC.
- The provider runs inside SqlClient's synchronous login, so it never waits for a person: for MFA it only looks for a
  cached token, else records by `ClientConnectionId` that a sign-in is needed. Only `connections.connect` and
  `.databases` then sign in through the system browser (MSAL, public client `2fd908ad-0664-4344-b9be-cd3e8b574c38`,
  redirect `http://localhost`, no WAM), under the request's own token, one at a time within 3 minutes (the 3 minutes
  include waiting for another sign-in), then open again with a new connection. MFA without a user name opens
  unpooled, and the stored connection string names the account the token was for.
- An unrecorded provider failure (SqlClient error 0, class 11) answers `AUTH_ENTRA` with SqlClient's text; a recorded
  failure answers its own code and sentence (`EntraFailures.Describe`). Only when a browser sign-in would be needed
  (`InteractionRequired`) on a method other than connect or Load databases does it answer `AUTH_ENTRA` ("Your Microsoft
  Entra sign-in for this server has expired or was revoked…").
- Authority hosts and resources the server names must be on an allowlist (public, US Government and China clouds; SQL
  audiences) before any token is requested. It does not limit which server receives the token: as in SSMS, silent modes (cached MFA, Integrated,
  Managed Identity, Default) send it to the named server with no prompt, so a hostile server could replay it until it
  expires (60 to 90 minutes). Main does not gate this, by the owner's decision.
- Every connect and Load databases gives up its open as soon as its token is cancelled, so Stop answers at once.

**Cancellation channels.** Cancellable requests carry a renderer `requestId`; main maps it to its REQUEST frame and a
cancel call sends CANCEL (reason 1) per id, answered `CANCELLED`. A cancel that arrives before the request was written is
sent right after it; one for an unseen id is a 60 s tombstone, and that request is refused `CANCELLED`. A running
`requestId` sent again is `DUPLICATE_REQUEST`, and a request past the Running cap is `TOO_MANY_REQUESTS`. `cancellableRequests` maps methods to channels.

| Registry | Channel | Ids per call | Tombstones | Running | Methods |
| --- | --- | --- | --- | --- | --- |
| `RendererRequests` | `varia:connections-cancel` | 1–16 | 64 | 8 | `connections.connect`, `.databases` (only with a context `requestId`) |
| `ExplorerRequests` | `varia:explorer-cancel` | 1–256 | 1,024 | 1,024 | `explorer.*` |
| `ScriptingRequests` | `varia:scripting-cancel` | 1–64 | 256 | 256 | `scripting.script` |
| `ActionRequests` | `varia:actions-cancel` | 1–16 | 64 | 128 | `actions.describe`, `.script`, `.execute` |
| `SsisRequests` | `varia:ssis-cancel` | 1–64 | 64 | 256 | every `ssis.*` |
| `ActivityRequests` | `varia:activity-cancel` | 1–16 | 64 | 32 | `activity.details` |

**Connect cancellation.** The Connect dialog's Stop, a changed form, and a closed dialog cancel a connect or Load
databases.

**A backend method is added in five places:** `RpcMethods` (`src/shared/contracts.ts`); `requestSchemas`
(`src/main/validation.ts`) or `portRequestSchema`; a `methodPolicies` entry; a preload or `ResultClient` method; and a
`SqlService.DispatchAsync` case with its `MethodNames` entry and record in `Contracts.cs`. A HELLO lacking a method main
may call is refused; lists that could exceed 16 MiB must be paged (`RESPONSE_TOO_LARGE`).

**Integrated identity.** Under Windows Authentication the User name shows `DOMAIN\user` on Windows (from main) and
elsewhere the default credential cache's principal from `connections.identity` (`gss_acquire_cred`, `gss_inquire_cred`,
`gss_display_name`; no KDC contact). Only a valid ticket answers a principal; anything else answers `{}`. One lookup runs
at a time, shared. Answer `{ principal?: str ≤ 256 }`: a principal with Cc or Cf characters is dropped, a longer one cut
to 256 with an ellipsis (never inside a surrogate pair); main checks the same bounds by code point (`resultSchemas`).

**Object Explorer cancellation** is the `varia:explorer-cancel` channel; there is no backend method. Catalog failures
(permission, access, missing object, lock, the 40 s budget, lost connection) are `result.error` values, not envelope
errors. SQL Server Agent's node answers `AGENT_DISABLED` (retryable) while its `Agent XPs` option is 0, as does any Agent read
that meets error 15281, and a login with no Agent role `PERMISSION_DENIED` with an Agent sentence. A database row carries `database: { state: int, userAccess: int, readOnly: bool, standby: bool }` from
`sys.databases`; a newer live status sample wins (`currentDatabaseRuntime`), a row-capped one only for its rows. A login
row carries `connectDenied: true` when CONNECT SQL is denied to it; its `status` stays `disabled` when also disabled.
`connections.connect` answers `providerId` (`sqlserver`; absent from an older backend means SQL Server) and `linux: bool` when the server's profile was read (`explorerServerLinux`) and
`engineEdition` (`explorerServerEngine`: `box`, `managedInstance` for edition 8, `cloud` for Azure SQL Database).

**Scripting cancellation.** The backend sends an attention for SMO's statement, answers at once, and keeps the job's
gate (2 per connection, 4 in all) until its thread ends; failures are `result.error` values (docs/scripting.md).

**Object action cancellation.** Stop and a disconnect cancel `actions.*` by `requestId` with an attention (which rolls
the statement back). Describe, script and disconnect answer `CANCELLED` at once; the job keeps gate and connection until
the statement ends. A user CANCEL (reason 1) of `actions.execute` is answered not by the protocol host but by the handler (`IRequestDispatcher.AnswersStop`): it
waits up to 10 s (`stopGraceMs`), then answers its result with steps `done`, `cancelled` or `skipped` and
`error: CANCELLED` (or success if the last statement finished first); past the grace, envelope `CANCELLED` (unknown
outcome). DDL runs after a preflight on its own unpooled connection (`ConnectRetryCount=0`, `LOCK_TIMEOUT -1`); describe
and script use `LOCK_TIMEOUT 10000`. A lost backend answers `BACKEND_LOST` (unknown outcome).
- `result.error` codes: `NOT_FOUND`, `NOT_SUPPORTED` (also every action on Azure SQL Database, before connecting),
  `PERMISSION_DENIED`, `IN_USE`, `BLOCKED`, `DEPENDENTS`, `NAME_IN_USE`, `PATH_NOT_FOUND`, `FILE_ACCESS` (a file SQL Server
  cannot open), `MEDIA` (unusable backup media), `BACKUP_MISMATCH`, `TAIL_LOG_NEEDED`, `RESTORE_SEQUENCE` (restore), `DATABASE_UNAVAILABLE`, `TIMEOUT`, `CONNECTION_LOST`, `SQL_ERROR`,
  `CANCELLED`, `AUTH_KERBEROS`, `AUTH_UNSUPPORTED`, `AUTH_ENTRA`, `AUTH_IDENTITY`, `PASSWORD_POLICY` (the server's password policy
  refused a password), `AGENT_STOPPED` (SQL Server Agent is not running), `JOB_STATE` (a job not running when stopped, or
  running when started), `SERVICE_UNREACHABLE` (the Service Control Manager on the server's machine could not be reached);
  the last three are not retryable (docs/object-actions.md, docs/sql-server-agent.md).
- `actions.execute` answers `{ steps: { status: done | failed | skipped | cancelled | rolledBack, title, message?,
  detail?, compensates?, progress? }[], messages: str[] (≤ 32 × 512), elapsedMs, error? }`; statements run in order and
  stop at the first failure; `rolledBack` marks a step undone by a later failure or Stop in its transaction. The
  backend's DryRun is for .NET checks only, unreachable from the wire.
- Delete Object's describe answers `deleteTarget { name, type, owner?, warnings: { text, blocking }[],
  dependentsTruncated, isSnapshot?, sessions?, withTransaction?, blockers?: { sessionId, program?, host?,
  openTransaction }[], blockersTruncated?, closeConnectionsNote?, transactionTabs?, identity?, login?, mappings? }`.
  Database: `identity` `{ id, created }` is what Delete names; session counts, blockers (≤ 8, never own pool sessions,
  program and host ≤ 128) and `transactionTabs` (≤ 1,000 session ids) need VIEW SERVER STATE;
  `closeConnectionsNote` says why Close existing connections is unavailable (Managed Instance, an offline database). Login: `login` is
  `loginFacts` plus `ownedJobs?` (absent when msdb cannot be read) and `grantedPermissions`; `mappings { users: { database, user, ownedSchemas,
  ownedRoles, readOnly, ownedSecurables, grantedPermissions, canDrop }[] (≤ 100), mapped, checked, notChecked }`, read
  per database within `loginLimits.scanMs` (unread databases count in `notChecked`, never an error).

**Action progress.** A long action (catalogue `long`: restore, verify, backup, Agent Start/Stop/Restart) runs under the long
gate; the next waits up to 30 s, then `BUSY` ("Another restore, backup or SQL Server Agent start or stop is running on
this connection." or "Restores, backups or SQL Server Agent starts and stops are already running on other connections."). Action statements use a data reader, never `ExecuteNonQuery`
(`tests/action-reader-lint.test.ts`).
- Message 3211 (`STATS`) becomes droppable `{ type: 'action.progress', step: 0–519, percent: 0–100 }` EVENTs: a step's
  start at once as 0, then at most every 250 ms (`progressEventMs`); a percent held inside the interval goes out when it
  ends or before the next step's start. 3211 lines are not kept messages; each step's `progress`
  holds its last percent.
- Stop goes through `ActionService.StatementStop` on the reader's thread, falling back to the Stop's thread after a
  second; a statement stopped before its reader reported the end is `cancelled`, never done.
- Main drops an invalid EVENT (`actionProgressEventSchema`; failing the request would CANCEL a restore part way) and
  pushes `varia:actions-progress { requestId, step, percent }` (`actionProgressSchema`) to the requesting window, ≤ 4/s
  per request: a new step at once, a percent held inside the interval when it ends, never after the request ended
  (`actionProgressRelay`, `onActionProgress`). The renderer's `ActionProgressService` keeps the latest percent of at most
  128 requests.
- On generation close, CancelAll stops long actions and shutdown waits (`DrainCommitted`) up to 10 s plus each one's
  cleanup budget.

**Integration Services** (docs/integration-services.md). `explorer.children` serves the Integration Services Catalogs
folder (2016+) and the catalog's folders, projects, packages and environments (refs carry `ssisFolder`, `ssisProject`), on
the SSIS read pool (program name + " - Integration Services", Initial Catalog the catalog database, READ UNCOMMITTED,
`LOCK_TIMEOUT 5000`); packages page by `package_id` (`@kb`).
- Linux, and Azure SQL Database without a visible catalog: `NOT_SUPPORTED`; catalog database gone `NOT_FOUND`, offline,
  restoring or single-user in use `DATABASE_UNAVAILABLE` (retryable), not openable `NO_DB_ACCESS`.
- An open catalog node follows the `ssis.catalog` live source ([Live subscriptions](#live-subscriptions)); an ended view
  reopens after 2 s doubling to 60 s unless it ended `PERMISSION_DENIED`, `LOGIN_FAILED`, `NOT_SUPPORTED`,
  `INVALID_PARAMS` or `PORT_CLOSED` (`catalogProbeFinalCodes`), until a refresh (`explorer.refreshed`) or reopen.
- `ssis.describe { connectionId, requestId, view: 'catalog' | 'folder' | 'project' | 'package' | 'environment', target }`
  (the target an Object Explorer ref of the view's own SSIS kind; the catalog only by its database's name) answers
  `{ model?, revision?, elapsedMs, error? }`: one batch on the same pool, READ COMMITTED under RCSI else READ
  UNCOMMITTED, retried once after error 601. `model.view` names it: the catalog's profile (`band`, `cloud`,
  `hostPlatform`, `auth`: sql, integrated or entra, `rcsi`, `features`, `roles`: `sysadmin`, `admin` for sysadmin or
  ssis_admin, and `ssisAdmin`/`ssisLogreader`, read only for logins that are not sysadmin), folder count and, for
  ssis_admin and sysadmin, `properties`; a folder's row and counts; a project's row, packages, parameters and references; a
  package's row and parameters; an environment's row and variables.
- Lists ≤ 2,048 rows, answer ≤ about 4,000,000 bytes (else `truncated`, and no `revision`); values ≤ 4,000 characters,
  never for sensitive parameters or variables. `revision` (64 hex) is a SHA-256 of what a later write depends on (names, descriptions, a project's
  `object_version_lsn` and last deployment, parameter values, references, variables, catalog properties; never validation
  results, counts or the profile).
- The SSIS profile is read once per connection (role checks `LOCK_TIMEOUT 1000`). `result.error` codes:
  `CATALOG_MISSING`, `NO_DB_ACCESS`, `DATABASE_UNAVAILABLE`, `BLOCKED`, `TIMEOUT`, `PERMISSION_DENIED`, `NOT_FOUND`,
  `NOT_SUPPORTED` (before 2016, Linux), `CONNECTION_LOST`, `AUTH_KERBEROS`, `AUTH_UNSUPPORTED`, `AUTH_ENTRA`, `AUTH_IDENTITY`, `SQL_ERROR`.
- **SSIS cancellation** is `varia:ssis-cancel`: an attention, answered `CANCELLED`.

**SSIS writes.** `ssis.execute { connectionId, requestId, action: { verb: 'stopOperation', operationId: 1 – 2^53 − 1 },
revision? }` (`revision` 64 lowercase hex, only for verbs that take one; verbs in `ssisActions`,
`src/shared/ssis/catalog.ts`) answers `{ steps: { status: done | failed | skipped | cancelled, message? }[], elapsedMs,
error? }`. Sensitive.
- Before connecting: before 2016 or Linux `NOT_SUPPORTED`; SQL authentication to a box server for catalog-changing verbs
  (27123) `WINDOWS_AUTH_REQUIRED`.
- SSIS write gates (1 per connection, 2 in all; 64 registered); own unpooled, unretried connection, no command timeout,
  program name + " - Integration Services Actions". Preflight READ COMMITTED, `LOCK_TIMEOUT 10000` (`BLOCKED`), 25 s
  (`TIMEOUT`); steps are constant `SsisSql` templates, `LOCK_TIMEOUT -1`, no outer transaction.
- Stop Operation: no row `NOT_FOUND`; type not 200, 300 or 301 `NOT_SUPPORTED`; ended or stopping `ALREADY_FINAL`
  (information); a created execution nobody started (it never runs) `NOT_STARTED` (not retryable). On 27124 or 27126 it re-reads: `ALREADY_FINAL`, `NOT_RUNNING` (retryable)
  if pending, else the refusal. Permission errors `PERMISSION_DENIED`; a lost connection `CONNECTION_LOST` (before the
  step: nothing changed; during: unknown).
- Stop is answered as for `actions.execute` (10 s grace). `catalog.stop_operation` commits its own Stop row (type 202)
  first, so a Stop during it may leave that row Running until SQL Server restarts. A disconnect cancels writes. Nothing
  is logged.

**Create Catalog** (docs/integration-services.md#create-catalog). `ssis.catalogSetup { connectionId, requestId }` answers
`{ setup?: { catalog, clrEnabled, startupDefault, backupFile, dataFile, logFile }, elapsedMs, error? }` from the SSIS read
pool. Refusals: Azure SQL Database, Managed Instance and other cloud editions, before 2016, Linux (`NOT_SUPPORTED`, before connecting); no sysadmin
(`PERMISSION_DENIED`); catalog exists (`CATALOG_EXISTS`); no catalog backup or file location (`NOT_SUPPORTED`).
- `ssis.execute { …, action: { verb: 'createCatalog', password, enableClr, startupProcedure } }` (`password` 1–128 UTF-16
  units, no U+0000 or lone surrogate; booleans required; no `revision`) runs in `master` (SQL logins allowed). Preflight
  repeats the setup read and `RESTORE FILELISTONLY` (25 s); CLR off without `enableClr` is `CLR_REQUIRED`. Steps (from
  `SsisCreate.Plan`, `SsisCreateSql` constants; the password only through server-side quoting): CLR, restore (never
  `WITH REPLACE`), master key, assembly trust, `sp_ssis_startup`, maintenance job.
- Stop cancels the running statement; the restore and its read-write switch get 30 s more (`restoreStopMs`). From the
  restore on, the reply waits up to 120 s past the grace (`createDrainMs`), then `CANCELLED` (outcome unknown). A failed
  or stopped step after the restore adds "Remove the incomplete catalog" (≤ 30 s per lock; its message, naming what failed, ≤ 2,048 characters). 27135 is `CATALOG_EXISTS`,
  removing nothing.
- A long run (`varia:long-runs`): the renderer refuses close, quit, disconnect and a restart of a backend that answers;
  a backend whose stdin ends
  waits up to 120 s for a Create Catalog past its restore to finish or remove what it made, and main waits 130 s (`createCatalogDrainMs`) instead of 2 s before killing it.
- Other dynamic `sp_configure` changes waiting for a `RECONFIGURE` (CLR in use or not) answer `CONFIGURATION_PENDING`
  from both methods, since enabling CLR runs `RECONFIGURE` and `sys.sp_procoption` ends with `RECONFIGURE WITH OVERRIDE`;
  each of those statements runs in its own batch behind `SsisCreateSql.PendingGuard` (error 50000 state 42), refusing a
  change staged after the preflight the same way.

**Activity Monitor session actions** (docs/activity-monitor.md) name a session by id and login time
(`YYYY-MM-DDTHH:MM:SS[.fffffff]`, server local, ≤ 40 characters; the backend refuses a time outside `datetime`'s range, 1753-01-01 to 9999-12-31T23:59:59.997, as `INVALID_PARAMS`).
- `activity.details { connectionId, requestId, sessionId: 1–32,767, loginTime, text?: statement | batch | inputBuffer,
  locks?: bool }` (not `text` with `locks`) reads on the Activity Monitor pool (READ UNCOMMITTED, `LOCK_TIMEOUT` 1000)
  under one live gate within 10 s. Answers `{ sessionId, state: present | ended | changed | unknown, session?,
  statement?, batch?, inputBuffer?, waits? (≤ 20), transactions? (≤ 50), transactionsTruncated?, tempdb?, locks?
  (≤ 1,000), locksTruncated?, sectionErrors?: { section, code, message }[], readAt?, elapsedMs, error? }`. Texts are
  `{ text, chars, truncated }`, cut at 65,536 characters unless `text` asks for one (alone, up to 1,000,000).
- `activity.kill { connectionId, sessions: { sessionId, loginTime, hostProcessId: int | null }[1..64] }` (distinct) runs
  on the object actions' connection one batch per session that checks it is not its own, a user session with that login
  time and host process, and not this backend's, then `KILL`. Answers `{ results: { sessionId, outcome: killed | ended |
  changed | own | system | varia | denied | failed, message? (≤ 2,000) }[], elapsedMs, error? }` (6102 `denied`, 6104
  `own`, 6106 `ended`, 6107 `system`); untried sessions are absent and `error` says why (`CONNECTION_LOST`, `TIMEOUT`
  past its 25 s budget, a sign-in failure); a session whose batch was cut off by either is `failed` with an unknown outcome.
- Value codes: `BLOCKED`, `TIMEOUT`, `PERMISSION_DENIED`, `CONNECTION_LOST`, `DATABASE_UNAVAILABLE`, `LOGIN_FAILED`,
  `AUTH_KERBEROS`, `AUTH_ENTRA`, `AUTH_IDENTITY`, `NOT_SUPPORTED`, `SQL_ERROR`. Envelope: `INVALID_PARAMS`, `NOT_CONNECTED`, `BUSY`,
  `CANCELLED`, `TIMEOUT`, `BACKEND_ERROR`. Nothing about a session is logged.

**Object action dialogs.** The dialogs below add no method: each is `actions.describe { connectionId, requestId, dialog,
target, … }` and `actions.script` / `actions.execute { action, connectionId, requestId, target, … }`
(docs/object-actions.md has statements by version). Below, `…` stands for that envelope. Scripts are ≤ 1,000,000
characters (`scriptChars`) unless noted. Where a request takes `identity?: { id, created }` (database_id and create_date,
`yyyy-MM-ddTHH:mm:ss.fff`), the preflight answers `NOT_FOUND` before anything runs if another database took the name.
"After closing idle pools" means the backend first closes its own idle pooled connections in the database; counts are
absent without VIEW SERVER STATE.

| Dialog | Describe answers | Script / execute |
| --- | --- | --- |
| **Database Properties** (`databaseProperties`) | `{ databaseProperties: { general (id, created), options, scoped, compatibilityLevels, collations (≤ 8,192), logins (≤ 1,024), files (≤ 1,024), filesTruncated, filegroups (≤ 256), filegroupsTruncated, server: { level, sysadmin, filestreamLevel, pathSeparator, edition, containedAuthentication }, sessions?, readOnlyReason? } }` | `action: 'properties'`, `closeConnections`, `changes: { owner?, options?, scoped? }` (only changed values, 1–512 statements), `identity?` |
| **Take Offline and Bring Online** (`takeOffline`, `bringOnline`) | `{ databaseState: { name, identity, state, userAccess, readOnly, standby, sessions?, withTransaction?, sessionList: [{ sessionId, login?, program?, host?, openTransactions }] (≤ 8, names ≤ 128), sessionsTruncated, warnings } }`; Take Offline's read after closing idle pools | `takeOffline` with `dropConnections`, or `bringOnline`; `identity?` |
| **Detach Database** (`detachDatabase`) | `databaseState` (after closing idle pools) plus `files: [{ fileId, name, type: rows \| log \| filestream, path }]` (≤ 256), `filesTruncated`, `confirmOffline` | `detach`, `dropConnections`, `updateStatistics`, `detachOffline?`, `identity?` |
| **Rename of a database** (`renameDatabase`) | `{ renameDatabase: { name, identity, userAccess, sessions?, withTransaction?, loginsDefaulting, canClose, connections (≤ 64) } }`, after closing idle pools | `rename`, `newName`, `closeConnections?`, `identity?` |

- **Database Properties.** Any database. Each change key is a settable option with one of its tokens (an integer as
  plain decimal text in range, a collation name of letters, digits and underscores);
  `closeConnections` (`WITH ROLLBACK IMMEDIATE`) only with an option SSMS closes connections for. Script writes
  `WITH NO_WAIT`, `database: 'master'`; execute runs one step per statement after recounting sessions (when execute has just closed
  idle pools, a count above zero is retaken every 50 ms for up to a second): such an option without `closeConnections` while others are in is `IN_USE`. Read-Only with a
  change SQL Server then refuses is `NOT_SUPPORTED` before anything runs, for Script too. Open Connections' Yes comes
  from main's `varia:confirm-open-connections` box (no payload, trusted senders only; `true` only for Yes). The Script drawer previews with `actions.script` only while open, one request
  once typing has paused for 300 ms, and cancels a preview an edit overtook (`varia:actions-cancel`).
- **Take Offline and Bring Online.** User databases, read in master. `NOT_SUPPORTED` where the catalogue greys the
  action or for a snapshot; `PERMISSION_DENIED` without ALTER ANY DATABASE, dbcreator, ownership or (while it is online) ALTER on the database. One step;
  without `dropConnections` SET OFFLINE waits until Stop. Bring Online notes SINGLE_USER or RESTRICTED_USER (read within
  5 s). 5011 is `PERMISSION_DENIED`.
- **Detach Database.** Azure SQL Database and Managed Instance `NOT_SUPPORTED`; neither sysadmin nor db_owner
  `PERMISSION_DENIED`. Blocking `warnings` cover replication, snapshots, availability groups and mirroring.
  `detachOffline` is required for a database not online on Windows; `updateStatistics: true` is refused when not online,
  read-only or standby. Steps: `Close existing connections` (with `dropConnections`), `Detach the database`
  (`sp_detach_db`), and a compensation restoring access (`compensates: true`) after a failure or Stop. A detach that SQL
  Server completed anyway is `done`. Once `Detach the database` is done, the result carries `filesKept` (≤ 256) and the
  backend forgets its pooled connections to the database. 3703 `IN_USE`, 3709 `DEPENDENTS`, 3707
  `NOT_SUPPORTED`, 7983 `PERMISSION_DENIED`.
- **Rename of a database.** The page sends the describe with the rename's own `requestId` (so Stop cancels it before
  anything runs); the execute reuses that id only once the describe has answered (`DUPLICATE_REQUEST` before).
  `connections` lists this backend's connections to the same server. Refusals: not online, read-only, standby (902), an
  availability group, or Managed Instance with `closeConnections` `NOT_SUPPORTED`; single-user in use `IN_USE`;
  `PERMISSION_DENIED`; `NAME_IN_USE`; changed identity `NOT_FOUND`. With `closeConnections`: close, `Rename`, restore
  access (compensated on failure). Without: `Rename` waits until Stop, retrying 5030 each second. The reply carries the
  new `identity` (absent if unreadable within 5 s).

**Login actions.** `dialog: 'loginFacts'` (`target: { kind: 'login', name }`) answers `{ login: { principalId, type,
subtype, disabled, connectDenied, own, sysadmin, sessions, canAlter, canControlServer, …, service?: ≤ 256 } }` read
under READ UNCOMMITTED; missing is `NOT_FOUND`.
- `disable` / `enable` take `loginIdentity?: { sid: ^[0-9A-F]{2,172}$, created }`; `rename` takes `newName`. A
  mismatched SID or creation time is `NOT_FOUND` before DDL. They run in master; execute answers `sessions`.
- `LoginRules` refuse `##…##` logins (also `INVALID_PARAMS` in zod), the connection's own login, a SQL login name with a
  backslash (`NOT_SUPPORTED`), and a taken name (`NAME_IN_USE`). A `newName` in the `##…##` form is `INVALID_PARAMS`
  (zod and `Validate`).
- A database's `delete` takes `identity?`, re-checked in each by-name batch (50010, `NOT_FOUND`).
- `delete` takes `closeConnections` and `deleteHistory` (required booleans; `true` only for a database);
  `dropMappedUsers?` and `loginIdentity` only for a login (`dropMappedUsers` only on `delete`; `loginIdentity` optional
  on script, required on execute). Refusals before DDL: sessions
  `IN_USE`; owned databases, jobs, roles, endpoints, availability groups or granted permissions `DEPENDENTS` (also 15173);
  with `dropMappedUsers`, uncountable sessions or more mapped users than listed `NOT_SUPPORTED` and a database the scan
  could not read again `BLOCKED`. Steps `Drop the database
  user` per user and `Drop the login`, each checking its principal (`PrincipalBinding`), each DROP checked first, then dropped and re-checked in a transaction of its own (steps share none); a mismatch (50010) is `NOT_FOUND` and
  that step drops nothing. 15434 is `IN_USE`.

**Unlock Login.** `dialog: 'unlockLogin'` answers `{ login, lock: { locked, badPasswords?, lockoutTime?, mustChange,
expired, daysUntilExpiration? } }` (`ActionSql.LoginLock`, the only `LOGINPROPERTY` caller; `BLOCKED` after 10 s).
`action: 'unlock', mode: 'keepPassword', loginIdentity?` (no password crosses) refuses a login not enforcing the policy,
one that must change its password (15128), or, for execute, one not locked (`NOT_SUPPORTED`). Execute toggles
`CHECK_POLICY` off and on (and `CHECK_EXPIRATION`) and commits in one transaction (`rolledBack` on failure); a login
changed meanwhile is `NOT_SUPPORTED` (`unlockChanged`).

**Object action confirmations** are main's message boxes on `varia:confirm-action` (trusted senders only): `{ prompt,
facts }` (strict, `actionPromptRequestSchema`, `src/shared/actions/prompts.ts`): `renameDatabase { database: 1–128,
sessions?: 0–1,000,000, transactions?: 0–1,000,000, tabs: 0–1,000,000, tabsWithTransactions: ≤ 8 names of ≤ 260,
moreTabsWithTransactions?, canClose }`, `disableLogin { login: 1–128, sessions?, service?: ≤ 256, sysadmin,
connections?: 1–8 names of ≤ 260, deny?: true }` or `disableChangeTracking { schema, table, reenable }`. Main words the
box from that catalogue (names through `displayText`) and answers the button id (`closeAndRename`, `renameWhenFree`,
`disable`, `deny`, `apply`, or `cancel`, also for Escape, close, reload or crash); the page can neither word a prompt nor
choose its default.

**Long runs** (`src/shared/long-runs.ts`): `varia:long-runs { runs: [{ kind, server: 1–256 }] (≤ 16), total:
0–1,000,000 ≥ runs }` (strict, no answer); main's reload and Restart SQL Backend prompts name the first run. The page
lets a long run reach Restart only while the backend does not answer (a run on a hung backend cannot stop); a reload or
crash resets the list.

**Table Designer** (docs/table-designer.md). `dialog: 'tableDesigner'` (database target) answers `{ tableDesigner:
{ database, band, schemas (≤ 2,048), schemasTruncated, defaultSchema, defaultFilegroup, caseSensitiveNames,
accentSensitiveNames, canCreate? } }`. `action: 'createTable', design: { schema, name, columns: [{ name, type: { system,
length?, max?, precision?, scale?, dimensions? }, allowNulls, identity?: { seed, increment } }] (1–1,024), primaryKey:
[index] (≤ 32) }`, checked by `designProblems` and `TableDesignValidator` (`INVALID_PARAMS`, also for a table name starting with `#` and
column names differing only in trailing spaces). Script answers SSMS's change
script (`designerLimits.scriptChars`) with refusals as warnings; execute runs CREATE TABLE, the key, `LOCK_ESCALATION` and
`Commit` in one transaction; a failure or Stop rolls it back. The design is one JSON parameter shredded with OPENJSON (master below level 130:
`NOT_SUPPORTED`).

**New Database.** `dialog: 'newDatabase'` (server target; SQL Server only, else `NOT_SUPPORTED`) answers `{ newDatabase:
{ model, dataPath, logPath, serverCollation, canCreate, masterLevel, linux } }`. `action: 'createDatabase', target:
{ kind: 'database', name }, design:
{ owner?, files: [{ name, type: rows | log | filestream, filegroup?, sizeMb?, growth, path, fileName }] (2–256),
filegroups: [{ name, type: rows | filestream | memoryOptimized, readOnly?, isDefault?, autogrowAllFiles? }] (PRIMARY
first, 1–256), collation?, containment: NONE | PARTIAL, ledger?, options, scoped }`, checked by `newDatabaseProblems` and
`NewDatabaseValidator` (data 1–16,777,215 MB, log 1–2,097,152, growth 1–2,097,152 MB or 1–100 %, maximum ≥ size and,
for growth in MB, ≥ growth (5169), platform-valid distinct file names). Execute refuses `NAME_IN_USE`, `PATH_NOT_FOUND` (2017+), `NOT_FOUND`
(owner, collation), `PERMISSION_DENIED`, then creates without compensation, through `CreateDatabaseSql` and
`QUOTENAME(@db) + N'.sys.sp_executesql'`. Long run kind `newDatabase`.

**Server file picker.** `dialog: 'serverFiles'`, `files: { purpose: backup | database | log | folder, path?, allFiles?,
exists? }` (`files` only with that dialog, `allFiles` never with `folder`, `exists` only with a path and no `allFiles`).
Paths are `serverPathSchema` / `ServerPath.Valid`: 1–260 UTF-16 units, well formed, no control characters or `*?"<>|`, a
drive, a share or `/`. Without a path it lists drives and default folders, else one level; `exists` checks the path
itself (`entries` its own entry or none). Answers `{ serverFiles: { separator, path?, roots: [{ path, kind: drive | folder, defaults?, freeMb? }], entries:
[{ name, directory, sizeBytes?, modified? }] (≤ 2,000), truncated, notice?: 'legacyEmpty' } }`. 15 s deadline; one listing
per connection (`browsePerConnection`). `PATH_NOT_FOUND`; cloud `NOT_SUPPORTED`.

**Attach Databases.** `dialog: 'attachDatabase', attach?: { mdf }` answers `{ attachDatabase: { server: { logins
(≤ 1,024), loginsTruncated, separator, dataPath? }, database?: { mdf, databaseName, version?, files: [{ original, type,
current, found? }] (≤ 1,000) } } }` via `DBCC CHECKPRIMARYFILE`; `NOT_SUPPORTED`, `FILE_ACCESS` (5120, 5123),
`PERMISSION_DENIED` (2571). `action: 'attach', databases: [{ name, owner?, files (1–1,000, none twice), rebuildLog }] (1–16, no name twice)`:
execute checks all first, then per database `Attach the database` and, with an owner, `Set the database owner`, compensating with
`Detach the database again` newest first. Execute's checks: name free, owner's login present, CREATE ANY DATABASE,
master at level 130 or more, primary file no newer than the server (a file that is not primary, or newer than master's
version, is `NOT_SUPPORTED` to the describe too). A long run.

**Restore Database.** `dialog: 'restoreDatabase', restore: { kind: 'history', database? } | { kind: 'devices', devices }
| { kind: 'historyFiles', setId } | { kind: 'mediaFiles', devices, file }` (1–64 devices) answers `{ restore: { server?,
historyDatabases?, sets?, files?, …Truncated } }` (130 s deadline, 120 s budget, `restoreLimits`; 2 reads per
connection). `action: 'restore'` takes the plan, `restore: { sets, relocate, recovery, … }` (≤ 1,024 sets, 1,000 moves). Script uses no connection and answers SMO's script
(≤ 4,000,000 characters). Execute (database target, `identity` over an existing one) is a long action (30 s cleanup); its
preflight checks identity, permission, tail-log, the chain (`RestoreChain`), WITH REPLACE (`BACKUP_MISMATCH`),
Close existing connections over a database not online (`DATABASE_UNAVAILABLE`) and target files (`NAME_IN_USE`). The reply adds `restored`: `{ state,
userAccess }` or `{ absent: true, filesLeft? (≤ 16), filesUnknown? }`.

**Restore Files and Filegroups.** `action: 'restoreFiles'`, `identity` required, `restoreFiles: { sets, files,
filegroups, relocate, replace, restrictedUser, recovery, standbyFile?, logBackup?: { file } }` (≤ 1,024 sets, ≤ 256 files
and ≤ 256 filegroups with at least one of them, 1,000 moves, ≤ 2,100 parameters). Extra refusals: `NOT_FOUND`, `NOT_SUPPORTED`, `RESTORE_SEQUENCE`,
`DATABASE_UNAVAILABLE`, `NAME_IN_USE`. `restored` adds `filesRestoring` (≤ 16).

**New Login.** `dialog: 'newLogin'` answers `{ newLogin }`: databases `{ name, state, accessible, readOnly }` (≤ 4,096),
languages (≤ 64), server roles (≤ 256), master's certificates and asymmetric keys (≤ 1,024 each), credentials `{ name,
provider? }` (≤ 1,024), each list with its `…Truncated` flag where it has one, the Securables page's lists, and the
server's facts, `engine` among them (`box` | `managedInstance`). `dialog: 'loginDatabaseRoles'` (database target) answers `{ loginDatabaseRoles: { roles
(≤ 256), rolesTruncated, guest, schemas (≤ 1,024), schemasTruncated } }`, or `NOT_FOUND` / `DATABASE_UNAVAILABLE`.
`dialog: 'windowsPrincipal'` (Check Names, a `DOMAIN\name` login target) answers `{ windowsPrincipal: { accountName,
access, type?, via? } }` or `NOT_FOUND` (15404 with Windows' 0x534) / `SQL_ERROR` (any other 15404: the server could not look the account
up) / `PERMISSION_DENIED` (229); off SQL Server it is `NOT_SUPPORTED` before connecting. `action:
'createLogin', login: { auth: windows | sql | entra | certificate | asymmetricKey, name, defaultDatabase?,
defaultLanguage?, checkPolicy?, checkExpiration?, mustChange?, certificate?, asymmetricKey?, credentials? (≤ 16) },
serverRoles, status, mappings (≤ 256 { database, user, defaultSchema?, rolesAdd (≤ 256, never public) }, one per
database)`, ≤ 512 statements; only execute carries `secrets`. The defaults go exactly with `windows`, `sql` and `entra`;
the policy options are all or none for `sql` (none on Managed Instance, all on SQL Server) and never for the others;
`certificate`/`asymmetricKey` exactly for their kind; `credentials` distinct, never for `entra`; no `defaultSchema` for a
certificate or key login. The backend re-validates all of it and refuses a kind or policy options the engine does not
take (`NOT_SUPPORTED`) before connecting.

**Table Properties.** `dialog: 'tableProperties'` (table target) answers `{ tableProperties: { general, storage,
changeTracking, permissions (≤ 1,024), permissionsTruncated, securityPredicates?, extendedProperties,
extendedPropertiesTruncated, temporal?, ledger?, level, readOnlyReason? } }`. `action: 'tableProperties', tableChanges:
{ lockEscalation?, changeTracking?: { enabled, trackColumnsUpdated? }, extendedProperties?: [{ op: add | update | drop, name, value? }] }, identity?`
(limits in `src/shared/actions/tables.ts`), one transaction (a failure or Stop rolls everything back); another table `NOT_FOUND`, changed plan or unsupported table
(SQL Server's own, external, dropped ledger) `NOT_SUPPORTED`. A read-only database is `NOT_SUPPORTED` to Execute only
(Script still answers).

**Login Properties.** `dialog: 'loginProperties'` answers `{ login, lock?, newLogin, loginProperties: { defaultDatabase,
defaultLanguage, serverRoles (≤ 256), serverRolesTruncated, users: [{ database, user, defaultSchema?, owner }], read
(databases Delete's scan read), credentials (≤ 1,024), credentialsTruncated,
certificate?, asymmetricKey? } }`; `loginDatabaseRoles` takes an optional `login` (≤ 128; no other describe takes it) and adds `user? { name,
defaultSchema?, owner }` and `memberOf`.
`action: 'loginProperties', loginIdentity?, loginChanges, secrets?`; `loginChanges` holds only changes:
`defaultDatabase?`, `defaultLanguage?`, `checkPolicy?`, `checkExpiration?`, `password? { oldPassword, unlock, mustChange
}` (the old password never with UNLOCK or MUST_CHANGE), `rolesAdd?`/`rolesDrop?` (≤ 256 distinct server roles, never
public, never both), `mappings?` (≤ 256 `{ database, change: map | unmap | update, user, newName?, defaultSchema?,
rolesAdd?, rolesDrop? }`, one per database), `credentialsAdd?`/`credentialsDrop?` (≤ 16 distinct, never both, never for
an Entra login), `connect? (grant | deny)`, `enabled?`; 1–512 statements. Execute needs `loginIdentity` and carries
`secrets: { password, oldPassword? }` exactly with `password` (`oldPassword` exactly with `password.oldPassword`); script
refuses `secrets`. No transaction: after a completed step a failure's message starts "The login was changed only in
part"; 15151 with an old password is `PERMISSION_DENIED`.

**Securables.** `newLogin.securables: { server, permissions, objects (≤ 1,024 names each), truncated }`;
`loginProperties` adds `permissions` (≤ 1,024 `{ securable, permission, state, grantor }`, none for SQL Server's own
logins) and `permissionsTruncated`.
`createLogin` and `loginChanges` take `permissions` (≤ 512 `{ securable: { type, name? (1–128, exactly when the type is
not server) }, permission, state: grant | withGrant | deny (| revoke | revokeGrantOption for Login Properties), cascade? }`,
never CONNECT SQL, each securable's permission once, `cascade: true` only with `deny` or `revoke`; each counts against the
512 statements). A request with permissions for sa or the connection's own login is refused before anything runs.
`dialog: 'loginEffectivePermissions', securable` (no other describe takes `securable`; never a `##…##` login) answers `{ effectivePermissions: { permissions (≤ 256), truncated } }`,
`PERMISSION_DENIED` (15406, 15517, 15151), `NOT_SUPPORTED` (a login SQL Server cannot impersonate: a group, or one
mapped to a certificate or asymmetric key), or `NOT_FOUND`. A permission step without effect (4624, or
another grantor's row left in place) fails `NOT_SUPPORTED`.

### Providers

Each `methodPolicies` entry may declare `providers` (`src/shared/providers.ts`); absent, the method serves SQL Server
only. `connections.connect`, `.databases` and `.preview` take an optional `provider` in their options (`sqlserver`;
absent means SQL Server, an unknown one is `INVALID_PARAMS`). `connections.connect` and `.disconnect` serve both engines:
a `bigquery` connect opens a BigQuery handle ([BigQuery](bigquery.md)). `.databases` and `databases.list` serve both
(BigQuery's datasets); `.preview` refuses `bigquery` with `UNSUPPORTED_PROVIDER`. `bigquery.account`,
`bigquery.projects`, `bigquery.dryRun` and `results.remoteQuery` serve BigQuery alone (`Providers.BigQueryMethods`). Two main-only channels serve the Connect dialog:
`varia:connections-pick-key-file` (main's file picker; answers an opaque reference and the file's name) and
`varia:connections-confirm-source` (records a federation token file the user confirmed), and one serves the cost prompt:
`varia:bigquery-cost-prompt` (`{ options, costPrompt }`, strict; sets only the saved entry's cost-prompt choice and answers
whether the entry holds it). Main records each connection's provider at connect and refuses a method whose `providers` lack the connection's
with `UNSUPPORTED_PROVIDER` before sending (`requestProvider`, `methodAllows`). `query.execute` serves both, refusing each engine the other's options (`optionsAllow`). `system.health`, `query.cancel`,
`query.session.close`, `query.session.state` and every other `results.*` method name no connection and are declared for
both engines; `SqlService.DispatchAsync` resolves their provider from the query, session or result and checks every request
again first thing (`Providers.BothMethods`, compared with the policies by `tests/validation.test.ts`).

## Streams and credits

`results.read { resultId: u32 ≥ 1, firstRow: 0 … 2⁵³ − 1, maxRows: 1 … 65,536, viewId?, viewer?: 1 … 2³¹ − 1 }` sends a
DATA frame for every sealed page overlapping `[firstRow, firstRow + maxRows)`, then the RESPONSE `{ nextRow, rowsAvailable,
complete, pages, rows }`. Rows in the open page builder are not served; the worker reads again after a progress event.
Unknown id: `RESULT_NOT_FOUND`; released: `RESULT_RELEASED`. A windowed BigQuery result is read from its block cache, may
answer short after waiting, and uses `viewer` (the grid asking) for its read-ahead ([Remote results](#remote-results)).

- **Credit counts DATA body bytes per stream.** The REQUEST's `credit` (clamped to 64 KiB – 16 MiB; the worker asks for
  4 MiB) is the initial grant.
- **Producer rule.** The backend may send a page whenever its credit is above 0, subtracting the body length, so credit
  goes negative by at most one page and a large page never deadlocks. Waiting for credit is a signal, not a poll.
- **Main's accounting.** Per stream, main tracks granted minus received and the expected sequence. A page at credit ≤ 0,
  a sequence gap, or DATA for a non-stream request fails that stream (`STREAM_PROTOCOL`).
- **Who grants.** The worker grants a page's length after decoding and caching it. Main relays CREDIT clamped to 16 MiB
  outstanding per stream and 64 MiB per port, passing on what the clamp held back as pages arrive or other streams end.
  A slow or hung renderer stalls its reads, never the query or SQL Server.
- Query events have no credit; they are bounded where produced. Live subscriptions' EVENTs are the exception: credited,
  one at a time ([Live subscriptions](#live-subscriptions)).

## Execution plan viewer

`plans.parse` accepts `{ xml }` from the renderer (≤ 8,388,608 characters). Only main creates the wire form
`{ xml: <base64 gzip>, encoding: 'gzip' }` (≤ 2,097,152 compressed bytes, at most two preparations at once); renderer
validation rejects `encoding`. The backend streams the XML through `XmlReader` (no DTDs or external entities, a character
limit, 256 levels deep). No SQL executes and no input or plan text is logged.

The answer is a normalized document: version/build, ordered statements, and per statement its operators with stable
document-local IDs and parent IDs (SQL Server NodeIds repeat across statements), names, estimates, runtime counters
(parallel rows, CPU and executions sum; elapsed takes the thread maximum; missing counters stay absent, never zero),
warnings and bounded properties. Limits: 512 statements, 10,000 operators, 64 properties per operator, 1,048,576
characters of SQL/property text, a 12 MiB answer; labels, objects and warnings have their own caps. Shortened text
carries a notice; malformed, oversized or overdeep documents fail with bounded, input-independent errors.

The renderer keeps parsed models and layouts in bounded caches that survive hiding and showing a viewer
(`preparationLimits` in `src/renderer/src/plans/preparation.ts`: 64 parses, 20,000 operators, 16 Mi characters; 32
layouts, 20,000 operators, 4 Mi units; [details](execution-plans.md#implementation-notes)); a viewer combines up to 64 documents, 16,777,216
input characters, 512 statements and 10,000 operators. Plans are read on demand through their result handles (invalidated by release and generation
changes); a truncated plan is never drawn as complete. `.sqlplan` files have their own 16 MiB / 8,388,608-character
limits. Layout (tidy tree, `src/renderer/src/plans/layout.ts`) runs in its own cancellable worker (20 s bound); drawing is one PixiJS canvas per batch, on
demand, within the strict CSP; a virtualized DOM outline serves keyboard, screen readers, no-GPU and forced colors.

## Query execution

`query.execute` takes `{ connectionId, sessionId, database?, dataset?, sql, queryId, maxRows, timeoutSeconds, startLine?,
startColumn?, maxResultSets?, stopOnError?, includeActualPlan?, discardResults?, maximumBytesBilled?, prices? }`.
`startColumn` (1 to 1,000,000) is a selection's first column, which BigQuery's `[line:column]` error positions add on the
selection's first line. `database` is required for SQL Server; `dataset` (≤ 1,024 characters) is a BigQuery query's
default dataset, `maximumBytesBilled` (1 to 2^53 − 1) Tools › Options' cap, which the job carries when its connection
sets none, and `prices: false` leaves the dollars out of the job's Messages line; SQL Server refuses all three. A BigQuery query runs as one job
whose rows are read into the same result store, and its summary adds `job` (`{ project, jobId, location?, statementType?,
bytesProcessed?, bytesBilled?, cacheHit?, slotMs? }`); SQL Server's options are refused for it ([BigQuery's
Execution](bigquery.md#execution)). `sessionId` is the query tab's UUID: its SQL session
is one unpooled connection with connection recovery off, opened on first execution and kept until the tab closes, its
server changes, or it is lost.

- **Actual execution plans.** With `includeActualPlan`, an observer connection runs a lightweight Extended Events session
  scoped to the query's physical connection and SPID; the query gets its batches verbatim. The summary's optional
  `planSets` holds up to 64 plans in execution order (statements before an error or cancel included), stored after the
  grids with an 8 MiB allowance, same page format and lifecycle as `resultSets`. Missing permissions, an unsupported
  server and incomplete capture are reported in Messages. When `SET STATISTICS XML` also returned the execution, the
  SQL-returned plan is kept and paired with one observer event of the same batch and repetition; optional `planOrder`
  lists matched and retained observer result IDs in event order, which orders plans within a batch and repetition;
  across them, batch and repetition decide. Collector naming, stale-collector recovery (16
  candidates per capture within its 5 s setup budget) and `ActualPlanSql.Lint`: [collector recovery](execution-plans.md#collector-recovery).
- **SET prologue.** Whenever a session opens, the backend first runs SSMS's query-window defaults (all sent, since
  `user options` can change login defaults): `SET ARITHABORT ON; SET ANSI_NULLS ON; SET ANSI_PADDING ON;
  SET ANSI_WARNINGS ON; SET ANSI_NULL_DFLT_ON ON; SET CONCAT_NULL_YIELDS_NULL ON; SET QUOTED_IDENTIFIER ON;
  SET NUMERIC_ROUNDABORT OFF; SET TEXTSIZE 2147483647;`. A script's own SET statements then persist in the session. A
  session whose prologue fails is closed, and the next execution opens a new one.
- **Database.** When `database` differs from the session's, the backend changes it before the first batch. A session
  with `SET NOEXEC`, `PARSEONLY`, `FMTONLY` or `SHOWPLAN_*` on compiles that `USE` without running it, so when SqlClient's
  catalog is unchanged the server confirms it (`DB_ID() = DB_ID(@database)`); when it does not, nothing runs and the result is
  `failed` (batch 0) with `database` still the session's and a message naming the options that cause this.
- **Batches.** `GO` and `GO n` split the script (SQLCMD commands are refused before anything runs; a line starting with
  `::` is T-SQL). As in SSMS, a batch that raised an error (severity 11–19) ends only itself; when a batch remains,
  Messages gets "Batch {b} raised an error; execution continued with the next batch." (for `GO n`: "Batch {b},
  repetition {k}, raised an error; execution continued with the next repetition." or "… next batch."). Severity 17–19
  errors do not stop the batch on the server either (SQL Server runs the whole batch; only SqlClient's view differs), but
  SqlClient raises them as exceptions: after the batch's first result set later sets and messages still follow in order
  (one raised mid-rows, such as 701, ends that set `incomplete`); before it, SqlClient reads the rest of the batch inside
  `ExecuteReader` (SqlClient 7.1.1), discarding the batch's later result sets (row counts remain) and listing its later
  messages before the error. `FireInfoMessageEventOnUserErrors` routes only severity ≤ 16 and no SqlClient switch changes
  this, so it is a known difference from SSMS, pinned by a live check that fails if a SqlClient update changes it. With `stopOnError: true` (SQLCMD's `:on error exit`) the first erroring batch ends the script. Nothing
  runs after a cancel, the deadline, a severity 20+ error, or any failure that closes the session.
- **Stop.** A cancel stops a batch wherever it is, also mid-message stream (`PRINT` loops, `RAISERROR … WITH NOWAIT`),
  by cancelling from inside the next message (`StatementStop`). A `query.cancel` that overtakes its `query.execute` is
  kept (≤ 256, one minute) and stops the query before any SQL; that answer says `cancelled: false`.

| `status` | Meaning | Status line |
| --- | --- | --- |
| `completed` | Every batch ran without an error | "Query executed successfully." |
| `completedWithErrors` | Every batch ran, at least one raised an error; `error` (`SQL_ERROR`) holds the first 20 errors and the first batch and repetition that raised one | "Query completed with errors." |
| `failed` | An error stopped the script: opening the session or changing its database, a batch with `stopOnError`, an error that closed the session, or an unexpected failure (`BACKEND_ERROR`) | "Query failed." |
| `cancelled` | `query.cancel`, a closed tab, a disconnect, or a CANCEL frame other than main's backstop | "Query was cancelled." |
| `timedOut` | `timeoutSeconds` passed, or main's backstop cancelled the request | "Query timed out." |

`completedBatches` counts finished batch executions, erroring ones included (also a batch whose output a severity 17–19
error raised before its first result set cut short; not the one that stopped a `stopOnError` script). Validation errors and a missing, busy or invalid session or connection use the error envelope, and nothing runs.

**Session identity.** On open, the prologue and `SELECT SUSER_SNAME();` go in one command; `spid` is
`SqlConnection.ServerProcessId`. Every summary returns `spid` and `login` (≤ 128 characters) while the session is open
after the script (both absent when it was lost or never opened) (status bar: `login (spid)`). Varia sends no SQL on the session after the script, so the next script
sees the previous `@@ROWCOUNT` and `@@ERROR`, and `DBCC INPUTBUFFER` shows the user's last SQL until a state read (below).

**Transaction state.** `query.session.state { sessionId }` runs `SELECT @@TRANCOUNT;` in an idle session and answers
`{ transactionCount, checked }` (control lane, 5 s, never waits). Running: `SESSION_BUSY`; unknown: `SESSION_CLOSED`
("This query has no open SQL session."); found lost: closed, `SESSION_LOST` ("The SQL session was lost, so SQL Server
rolled back its transaction."); for an ended generation or with no backend main answers `SESSION_LOST` itself (`sentences.sessionEnded`:
"The SQL session ended with the SQL backend, so SQL Server rolled back its transaction."). Under `SET SHOWPLAN_XML`, `_TEXT`,
`_ALL`, `NOEXEC`, `PARSEONLY` or `FMTONLY ON` it answers `{ transactionCount: 0, checked: false }`, options untouched.
The read is a statement in the session, and the renderer reads every idle connected query a flow covers, not only those
it then asks about: a kept session then sees `@@ROWCOUNT` 1, `@@ERROR` 0, and other sessions see `SELECT @@TRANCOUNT;` as
its most recent SQL (`DBCC INPUTBUFFER`, `sys.dm_exec_input_buffer`). A cancel does not roll
back; an `XACT_ABORT`-doomed transaction ends by the batch's end (3998).

**Ending a session.** `query.session.close { sessionId, transaction?, abortOnRefusedCommit? }` answers
`{ closed, note? }`. `abortOnRefusedCommit` (default true) and `note` are BigQuery's ([BigQuery's
Sessions](bigquery.md#sessions)): a commit refused on an unchecked session ends the session with a note unless quitting
sent false; `note` is `{ code, message? (≤ 2,000 characters), jobId? }`, `code` one of `commitNotApplied`,
`committedBeforeCancel`, `outcomeUnknown`, `abortFailed` and `sessionExpired`. A BigQuery commit or rollback close on a
session whose job is still running or still being cancelled answers `JOB_RUNNING`, and the session stays. Main checks the
answer (`sessionCloseResultSchema`). For SQL Server: Without `transaction`, or with `'rollback'`, it
cancels any running script and closes the session; SQL Server rolls back, unwaited. `'commit'` reads `@@TRANCOUNT`
(if no row, or a plan, came back, it turns SHOWPLAN, `NOEXEC`, `PARSEONLY` and `FMTONLY` off, then reads again), then,
only with a transaction open,
runs `WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION; SELECT @@TRANCOUNT;` and checks 0 is left. An unknown session answers `{ closed: false }` for any close.

With `'commit'`:

| Case | Answer; session |
| --- | --- |
| Script still running | `SESSION_BUSY`; stays open |
| Commit refused or leaves a transaction | `SQL_ERROR` "The transaction was not committed, and the query stays open. Msg …"; stays open |
| Deadline or cancel interrupts the commit | `TIMEOUT` / `CANCELLED`; stays open, outcome remembered as unknown |
| Lost before the commit was sent | `SESSION_LOST` "The SQL session was lost, so SQL Server rolled back its transaction. Nothing was committed." |
| Lost while committing | `SESSION_LOST` "The SQL session was lost while committing, so it is not known whether its transaction was committed. Check the data before running the work again." |
| Found lost after an unfinished commit | `SESSION_LOST` "The SQL session was lost after a commit that did not finish (it was cancelled or timed out), so it is not known whether that commit took effect. Check the data before running the work again." |

A severity 20 error counts the session lost even while its connection still reads open.

**Session limit.** At most 1,000 query sessions, a backstop (running scripts are bounded by main's 256 pending requests,
with 32 more reserved for control-lane requests (cancels, state reads, closes), so the renderer sends state reads and cancels 8 at a time and closes one at a
time). The next is refused with `SESSION_LIMIT`: "This query was not executed: 1,000 query tabs already hold SQL
sessions, the most Varia SQL Manager keeps open. Close query tabs you no longer need, or disconnect idle ones (Query >
Connection > Disconnect), then execute again." Idle sessions are never reclaimed: their state is invisible from outside.

**Prompts.** Before sessions end, the renderer reads each idle query's state (8 at a time, 5 s in all). A count above 0
is an open transaction; `checked: false`, a read not done in time, or a failure other than a gone session
(`SESSION_CLOSED`, `SESSION_LOST`, `NOT_CONNECTED`, `CONNECTION_LOST`, `BACKEND_LOST`), e.g. `SESSION_BUSY`, `TIMEOUT`,
`TOO_MANY_REQUESTS`, is `unchecked`. A BigQuery tab's state is the backend's tracked transaction, read with no request to
BigQuery. After a `SESSION_LOST` read the query's next run first says it runs in a new SQL session
and that its previous transaction was rolled back, unless the query moves to another connection or disconnects first. It sends main `varia:confirm-sessions { action, tabs }` (`action`: `close`, `closeAll`,
`changeConnection`, `disconnectQuery`, `disconnect`, `disconnectAll`, `exit` or `switchLocation`; ≤ 1,024 tabs `{ name ≤
512, transactions, running, unchecked?, provider? }`, only those with an open or unchecked transaction or a running
script). `provider` (`sqlserver` or `bigquery`) picks the "not checked" note's causes. A BigQuery tab switching to a
dataset in another location first sends `location: { dataset, from, to }` with that one tab, which asks "Switch this tab
to …?" (Switch or Don't Switch). Main composes the box (`src/shared/sessions.ts`) in its dialog queue; a crashed page
gets Cancel.

- Open transactions ask SSMS's "There are uncommitted transactions. Do you wish to commit these transactions before
  closing the window?" (or before changing the connection, disconnecting, disconnecting the server, closing Varia SQL
  Manager), **Yes** (commit, default), **No** (roll back), **Cancel** (Escape); unread ones say "There may be
  uncommitted transactions" and are listed as "not checked". Several queries are asked about once, listing up to 10 by
  name with their nesting.
- Running queries are asked first, in a box of their own, **Cancel Query and Close** or **Keep Running** (default and
  Escape); the open transactions go in a second request only after Cancel Query and Close, and nothing is cancelled
  until both are answered. A running query is cancelled (up to 15 s), never committed. (A request mixing both lists the
  running queries under "Still executing" and defaults to Cancel.) Then `query.session.close` runs with the chosen
  `transaction`; a failed commit stops the flow. Close All and Disconnect All Queries leave running queries alone; one
  that finished after the prompt opened is read then, and if it may hold a transaction it stays open and is reported. A
  run that settles after its tab closed still has its results released. Wording details: `src/shared/sessions.ts`.

## Query events

EVENT frames whose id is a running `query.execute` or `results.remoteQuery` request. Main validates each
(`queryEventSchema`), stamps the generation on descriptors, registers the result as owned on `resultSet.opened` (a
`resultSet.residence` only refreshes a result still owned, and disowns one it names released), and forwards it on the port (or drops it when no port is open).

| type | Emitted |
| --- | --- |
| `session.opened` | Before the first batch, once a live query session is acquired; carries `spid` and optional `login`. The summary still says whether the session survived |
| `resultSet.opened` | When a kept set's columns are known, before its first row; carries the descriptor |
| `progress` | At most 10 a second per query, latest wins; up to 64 sets with `rowsRead`, `rowsStored`, `rowsAvailable`, `bytesStored`, and `truncated` (the descriptor's reason) once a set stopped storing. A sealed page is reported at once when no progress went out in the last 100 ms, and every set's first sealed page at once |
| `messages` | Every 100 ms or 65,536 characters, only entries stored under the message caps: `{ text, kind: 'info' \| 'print' \| 'server' \| 'error' }` ([Messages](#messages)) |
| `resultSet.closed` | Once per kept set, with its final descriptor |
| `resultSet.residence` | A BigQuery set switched between memory and windowed, with its new descriptor (`residence` and `revision` always present) ([Remote results](#remote-results)) |
| `query.job` | A BigQuery request's top-level job as it starts (`running`) and finishes (`done`): `{ jobId, project, location?, state, auxiliary, transaction }`, `transaction` (`none`, `open`, `unknown`) being the session's as the job started; never the session id |

Progress and messages are droppable: refused while the control lane holds 1,000 frames or 8 MiB, and dropped over
256 KiB. `session.opened`, `resultSet.opened`, `resultSet.closed`, `resultSet.residence` and `query.job` are essential: never refused, up to 4 MiB (a
4,096-column descriptor with 128-character names). RESPONSE, PONG and GOAWAY are never dropped. The summary is
authoritative; a query's events after it are ignored.

### Global memory events

| type | Emitted |
| --- | --- |
| `results.memory` | Checked once a second, and after `results.close` and `results.setMemoryLimit` before their answers; reports the first sample and any change of use or of the global figure. A query summary's `budget` counts as a report and shares this sequence (so an older summary can be discarded); as it has no `detail`, the next check after one always sends, and main keeps the last event's `detail` until then |
| `explorer.index.memory` | Checked once a second and after a disconnect drops a connection's index; reports the first sample, changes in the shared index budget's use (a fall below the last walk's figure waits for the next walk, at the first check 5 s after the last), a build's end, a disconnect and a finished search (whose time `detail` carries). Own sequence |

Both are droppable; a refused sample consumes no sequence number and stays eligible. Main pairs each sequence with the
generation, keeps the latest per feature, and replays both when a results port opens.

`results.memory`'s `detail` (`resultMemoryDetailSchema`, `ResultMemoryDetail`) is what the store holds, for the status
bar Memory panel's Nerd metrics ([status-bar-memory.md](status-bar-memory.md)); it is read only when an event goes out.

| Field | Meaning |
| --- | --- |
| `logicalBytes` | Every stored result's pages uncompressed |
| `storedBytes` | Raw pages plus compressed ones: `logicalBytes` − `packedLogicalBytes` + `compressedBytes` |
| `compressedBytes`, `packedLogicalBytes` | The compressed pages' size with their Find filters, and the uncompressed rows they hold |
| `cacheBytes` | Decompressed pages kept for reads |
| `windowCacheBytes` | Optional: the block caches of windowed BigQuery results ([Remote results](#remote-results)), apart from `logicalBytes` |
| `largest` | At most 8 results, largest first: `{ resultId, logicalBytes, storedBytes, state: 'raw' \| 'partial' \| 'packed' \| 'unpacking', progress? (0 to 100, only while unpacking), live? (a live view's table) }`; `partial` = a packing pass not finished |
| `codec` | Since start: `name` and `level` (`zstd`, 2; absent while compression is off), `pagesPacked`, `pagesUnpacked`, `packInputBytes`, `packMicroseconds`, `unpackOutputBytes`, `unpackMicroseconds`, `cacheHits`, `cacheLookups`, `lastUnpackMicroseconds` (last whole-result unpack; 0 before one) |
| `heap` | After the last GC (`GC.GetGCMemoryInfo`): `committedBytes`, `freeBytes` |

`explorer.index.memory`'s `detail` (`indexMemoryDetailSchema`, `IndexMemoryDetail`, worked out by `IndexMemoryReport`) is what
every connection's Search Objects index holds, for the same panel. It is read only when an event goes out, never by a search:
one walk of the held tables, each counted once (a shared resource set once, however many connections show it). A refused event's detail is kept for its retry, and the timer skips a check while another report is still walking. Main forwards
it to the page as the report's `index`.

| Field | Meaning |
| --- | --- |
| `connections`, `objects` | Connections whose index holds something, and the objects their held tables list |
| `texts`, `references` | The shared pool's distinct names and definitions, and the references reads and resource sets hold to them |
| `definitions`, `packedDefinitions` | Objects with a definition, and those whose definition is packed |
| `definitionTexts`, `packedTexts` | The distinct definitions the held tables hold (modules, constraint and computed column expressions, plan guides: texts an object names as its definition, and packed ones, including one pooled for a row a read then left out), and how many are zstd frames (`PackedText`) |
| `packedBytes`, `packedTextBytes` | What the packed definitions cost the budget, and what they would as strings |
| `recordBytes`, `nameBytes`, `definitionBytes`, `readingBytes` | The budget's use by what holds it: records (with each read's slots for its texts, and the column types, keys and index columns the editor reads), names, definitions, and what reads still running have added (their records and pooled texts; a rebuild's records count against the table they replace until it is swapped in, so only growth beyond it shows). They add up to `usedBytes`. The walk behind them runs at once after a build's end (finished, stopped or failed) or a disconnect, else at the first check 5 s after the last: between walks a budget at or above the last walk's counts the change as reading, and a fall below it is sent with the next walk. A walk that still shows reading is repeated at the first check 5 s after it, though nothing moved (holding a read changes no byte), and sends an event only when the detail changed |
| `cut`, `childrenLeftOut` | Definitions left out or cut short; held databases read without their children (`CHILDREN_LEFT_OUT`), whatever later builds reported |
| `lastBuildMs`, `lastSearchMs` | The last finished build's and search's time; absent before the first |

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
  valid, none truncated, no errors). Validity 1 means non-NULL; bits past the last row are 0. A truncated cell is
  non-NULL and holds a stored prefix; a read-error cell is NULL.
- **Offsets** are `u32[rowCount + 1]`, 8-aligned in the blob, from 0, non-decreasing, ending at `dataLen`; a NULL cell
  has an empty span.
- **Text** cells hold the SSMS display text as UTF-8; **binary** cells hold bytes, shown as `0x` and uppercase hex.
- **Sealing.** At 256 KiB or 4,096 rows; a result's first page at 64 rows or 20 ms after its first row; an idle page
  after 200 ms without rows; and at the end of the set. An encoded row is at most 8 MiB: cells past that are stored as
  truncated prefixes.
- **Building.** `PageBuilder` writes the header with the MessagePack writer, places every region 8-aligned, and copies
  everything into one exact-size array, both stored and written to stdout. `encodePage` (TypeScript: tests, fake
  backend, benchmarks) writes byte-identical pages; golden pages are in `tests/fixtures/pages/`.
- **Decoding.** `decodePage(body, columns)` in the worker checks every bound above, each column's wire kind against the
  descriptor, that every region lies inside the blob and nothing trails it; it throws only `PageFormatError`. It returns
  zero-copy `Uint32Array`/`Uint8Array` views and decodes text only for cells a window asks for (one call per column and
  page for runs of small ASCII cells, `textRun`; otherwise `cellText`), capped without splitting a surrogate pair.

## Result store and memory budget

Results stay in backend memory, never on disk (`ResultStore`); a windowed BigQuery result keeps only a budgeted block cache
and reads its rows from BigQuery ([Remote results](#remote-results)).

- **Budget.** Global: a quarter of the process's available memory (container-aware), within 256 MiB – 16 GiB, or the
  Tools › Options limit (`queryResults.grid.memoryLimitGiB`, 0 = automatic) up to three quarters of it; one query may
  use half. Main passes it at launch (`VARIA_RESULT_MEMORY_MIB`) and sends `results.setMemoryLimit` as each generation
  becomes ready, on change, and after each successful settings read. Lowering it drops nothing: reservations are
  refused (storing queries stop with `globalBudget`/`queryBudget`; queries, sorts, pivots and live revisions are refused)
  until use falls under it; raised, the room is there for the next reservation. A stopped query never resumes (operations
  on it answer `BUDGET_STOPPED`). A query's own ceiling fixed when it began (an actual plan's) stays: the smaller of it and
  the current half holds. Test hooks'
  `VARIA_RESULT_BUDGET_BYTES` fixes the figure and turns off the memory-load check.
- **Allowances.** A comparison that replaces another (`results.diff`'s `replaces`, [Result diffs](#result-diffs)) raises
  its query's limit by the replaced comparison's whole charge (its rows, metadata, change index, views, identity and
  value lists) while both are held, so a new comparison can be written beside the old one it replaces. The query's
  limit is `min(half, its own ceiling) + allowances` (`ResultStore.QueryLimit`), read by every reservation of the query:
  rows, working memory on any thread, rooms, waits for room and spare memory alike. One allowance per replaced
  comparison, granted once; allowances of different comparisons add up. It ends when the replaced comparison's bytes go
  back (its release, after its last lease or pin) or when nothing holds it (the replace failed or was cancelled, or the
  new comparison was released first). While it lasts the query's other operations (sorts, filters, pivots, profiles of
  any of its results) may use the raised limit too, so the query's use can pass its half (the meter above 100 %); the
  global budget and the memory-load check are not raised.
- **Working memory** of operations (sort keys, profile figures) is charged to the same budget (pinned by
  `tests/working-memory-lint.test.ts`). Reservations of 64 MiB or more, any memory that only makes an operation faster once 64 MiB
  of it is held (`ResultStore.TryReserveSpare`), and stepped ones (`WorkSteps`) at each further 64 MiB, are refused under high system memory load with `TOO_LARGE` (low on memory); refused Distinct Count bounds are not an
  error (the pivot sorts by cell and value instead), and a profile refused on several threads is read again on one.
  Nothing more is stored while the OS reports high memory load (checked at every page seal; the load is the runtime's
  reading at its last GC, refreshed by a gen0 collection when more than a second old).
- **Charges.** A sealed page costs its length (packed length plus its Find filter's bytes once packed, [Search in results](#search-in-results)) + 96 bytes + its cell lengths
  ([Cell lengths and row sizes](#cell-lengths-and-row-sizes)); a set's metadata 512 bytes + 2 per name character + 64
  per column; the page builder's space in 256 KiB steps. A failed reservation rolls back the current row; later rows
  are counted in `rowsRead` but not stored, later sets count in `discardedResultSets`, and execution continues.
- **Discarded results.** With `discardResults` no set's rows are stored or charged; each counts in
  `discardedResultSets` and an info message gives sets and rows read, also when the run is stopped or fails. Execution
  plan sets are still kept, within `maxResultSets`; rows after a plan's row in its set are not kept (`ResultSetTally`).
- **Rows per query.** `maxRows` 0 – 2,147,483,647 across sets (0 = budget only, the default); a plan set's first row is
  kept past it and not counted. **Result sets kept:** `maxResultSets` 1 – 1,000 (default 10); later sets are counted. Kept descriptors may
  take 8 MiB of the 16 MiB summary, each bounded by `512 + Σ(UTF-8 name + UTF-8 type + 96)` bytes; a set past that, and
  later sets, are discarded.
- **FOR XML and FOR JSON.** A set whose only column is `XML_F52E2B61-18A1-11d1-B105-00805F49916B` or
  `JSON_F52E2B61-18A1-11d1-B105-00805F49916B` (ntext or nvarchar) is joined (`ForXmlCollector`) into one value of up to 2,097,152 characters
  (one more marks it truncated; reserved from the query's budget in 256 KiB steps), stored as one row
  (`rowsRead` = `rowsStored` = 1) with role `xml` or `json`. `FOR XML … TYPE` already arrives as one xml cell.
- **Never unowned.** A summary that cannot be encoded (`RESPONSE_TOO_LARGE`) releases its results at once.
- **Descriptor.** `{ generation, resultId, index, batchNumber, iteration, kind: 'rows' | 'executionPlan', columns,
  rowsRead, rowsStored, rowsAvailable (rows in sealed pages), bytesStored, truncatedCells, state: 'open' | 'complete' |
  'released', truncated?, incomplete, name? }`. Result ids are u32 from 1 per generation, always paired with it. `name`
  comes from a `#Name="…"` marker comment before the statement (docs/named-result-sets-scope.md): 1 to 128 characters,
  trimmed, no control, line separator or bidirectional characters; `backendDescriptorSchema` refuses one out of bounds. Absent for plan sets, Pivots and comparisons; its
  bytes count toward the 8 MiB of descriptors.
- **Released** by `results.close`, the next `query.execute` on the same session (whatever its connection), and process
  exit; closing a session or disconnecting keeps results. A release fails in-flight reads with `RESULT_RELEASED` after
  the current page and stops storing at once.
- **Visibility.** `results.visibility` gives the ids of results whose grids are shown (rendered with a size in a
  visible window) in any window; live tables always count as hidden. The renderer sends the whole set on change and on
  each return to ready, never on a timer. `ResultVisibility` keeps the set and when other results became hidden; the
  packer asks it, never under store locks.
- **Packing results.** A complete result of 1 MiB or more is packed when hidden for 5 s (stage 1) or shown but idle for
  30 s (**Stage 2**, `ResultPacker.VisibleIdleMs`, doubling per whole unpack up to 4 minutes): each page becomes
  Zstandard level 2 bytes of its lengths form with typed columns ([typed form](page-compression-findings.md#typed-form); a page
  saving under a tenth stays raw), charged at its packed size. A query's own result is also packed as it stores, each
  page as it seals once the result holds 1 MiB, on a thread of its own beside the reading thread
  ([at seal](page-compression-findings.md#at-seal)). The policy never packs a result still
  storing, a live table, or one held by a read, operation, Copy or Save; a sorted or filtered grid does not keep its
  result raw, and sorting or filtering a packed result reads it packed and leaves it packed. `ResultPacker` runs on its own thread, compressing at the lowest priority (honoured on Windows) but taking
  locks and allocating at normal priority (never preempted holding a lock), one result at a time (hidden first, then largest), outside
  the workers' gate (except packing for a waiting query), and stops between pages when the result is shown, read, held or released. Reads, Copy, Save and
  most operations read packed pages directly; an operation that must unpack reserves the raw size first and answers
  `TOO_LARGE` when refused. Rationale: [page-compression-findings.md](page-compression-findings.md#stage-2-as-built).
- **Room for a query.** A query row its half or the global budget refuses waits (≤ 10 s a wait,
  `ResultStore.RoomWaitMs`; 4 waits a row, `SqlService.MaxRoomWaits`; 30 s a query, `SqlService.MaxRoomWaitMs`; never
  a live table's or a derived set's row) while the packer packs other unheld complete results of 1 MiB or more on the
  results' workers (any query's for the global budget, only the query's own when its own half is full), except one an
  operation unpacked and still uses, and while its own pages queued for packing at seal pack; then it retries, or the
  query is truncated.
  SQL Server sees `ASYNC_NETWORK_IO` meanwhile.
- **Leases.** `results.copy` and `results.export` lease their result: released mid-job, it leaves lookup at once (new
  reads get `RESULT_RELEASED`) but is freed when the last lease ends. Every 64 MiB released (across releases) triggers a gen2 collection,
  as does a release that empties the store once 16 MiB were released since the last compacting one
  (`ResultStore.CompactWhenEmpty`); it compacts only when what remains is no more than was released since and ≤ 8 GiB
  (waived under high memory load), else it does not compact.

Notes appended to the summary's messages:

| `truncated` | Note |
| --- | --- |
| `rowLimit` (or truncated cells) | "Results were truncated by display limits. Display limits do not stop script execution." |
| `queryBudget`, `globalBudget` | "Results were truncated because the result memory budget ({n} MB) is full. Execution continued; close other query results to free memory." {n} is `budget.stoppedBytes`, or the current half or whole budget when it did not stop |
| `systemMemory` | "Results were truncated because the computer is low on memory. Execution continued." |
| more than `maxResultSets` sets | "Only the first ten result sets are displayed. Display limits do not stop script execution." ("first {n}" for other limits) |
| column lists past the summary's 8 MiB | "{n} later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution." |
| an error stopped the script before later batches (`stopOnError`, or an error that closed the session) | "Batch {b} raised an error; later batches were not executed." ("Batch {b}, repetition {k}, raised …" for `GO n`); nothing when no later batch was skipped |
| a cancel or timeout skipped later batches | "Stopped at batch {b}; {c} of {t} batch executions completed." (", repetition {k}" for `GO n`) |

A cell whose typed read fails becomes NULL with the error flag and its column switches to a fallback reader: "Column
‘{name}’ ({type}): some values could not be read and are shown as NULL." An xml value read through the `GetXmlReader` fallback whose rest past the cap fails to
parse keeps its prefix (truncated, an estimate): "Column ‘{name}’ ({type}): some values could not be read to the end
and show only the part read before the error." Under a Stop, a value that parses as malformed ends the read as the Stop
instead.

## Remote results

A BigQuery result is either in memory, as SQL Server's are, or **windowed**: its rows stay in the job's destination table
and the backend reads them in blocks as the grid asks (docs/bigquery.md, Residence). Its descriptor says which:

- `residence`: `memory` or `remote` (absent for SQL Server); `rowsTotal`: BigQuery's own total, which may pass
  `rowsAvailable` (at most 2,147,483,647 rows, the grid's 32-bit indexes; a Messages line says so);
  `revision`: 0, bumped by every switch.
- **Choosing.** `query.execute` takes `residence` (`automatic`, the default; `memory`; `windowed`) and `windowCacheMiB`
  (16 – 4,096, default 64), BigQuery only: main (`optionsAllow`) and the backend refuse them for SQL Server. The backend
  decides after the first page, before `resultSet.opened`: memory when the rows arrived whole, under `memory`, or when
  the first page's measured row cost times the rows within `maxRows` fits half of what the query and the global budget
  may still take; otherwise windowed, with
  the first page kept in the cache. A result whose destination table cannot be read stays in memory.
- **A misestimate.** An `automatic` result kept in memory that the budget refuses part way switches to windowed instead
  of truncating: its pages are freed, `revision` goes up, and `resultSet.residence` carries the new descriptor. The
  renderer drops every cached page and window of the result, ends its reads in flight without an error, keeps the grid's
  scroll and clears its selection.
- **Reading.** `results.read` sends the cached pages covering the window (whole pages, so it may send rows either side)
  and fetches the blocks it lacks with `tabledata.list` (free): about 4 MiB of measured rows each, 256 – 16,384 rows (fewer
  when half the cache, allowing the estimate's 25% margin, holds fewer, one at least); at
  most 2 fetches per result and 4 per connection; a 429 backs off with jitter. It waits up to 20 s (inside its deadline)
  and then answers with the rows it has; the grid draws the rest as loading and reads again. Each `viewer` reads ahead
  one block either side and one more in its direction of travel (only as many as the cache holds beside the read's own
  blocks, counting a block at the widest its rows have come out so far, a block too wide for the cache at least the cache's size); a jump cancels that viewer's stale read-ahead. A fetch a read started that no read waits for any more (the read
  was cancelled or answered short) becomes its viewer's read-ahead: the viewer's next read joins it, and a jump stops it.
  A block nothing was fetched into leaves the cache's lists once no read waits for it.
  `results.rowBytes` answers from the cache only. The cache is LRU per result, charged to the global budget (the memory
  detail's `windowCacheBytes`), and reserves a block's estimate before fetching it and any overrun after, within its own
  limit (`TOO_LARGE` when the global budget has no room, or when one block's rows outgrow the cache: the block stops
  being built there). A block's estimate the cache's own limit refuses (reads of the result hold it) stops a block
  only read ahead, with nothing fetched; one a read waits for may pass the limit, up to twice it, as an overrun may. A
  block only read ahead never evicts one a viewer's last read covered, nor takes the room of a block a read waits for that has not reserved yet, and its own overrun stops it there too. An overrun the cache's limit refuses while another fetch of the result holds room stops read-ahead
  no read waits for and waits once for the rest; when the read's own blocks still do not fit together, the overrun passes
  the cache's limit, up to twice it (the global budget still refusing it; past that, `TOO_LARGE` names the window cache
  and its setting), and the cache trims back once no read holds them. A read that already sent rows answers short with them instead of failing, whatever stops a later
  block (refused room for a window wider than the cache, the table expiring, the cache going on Load into memory, or a
  fetch error); a rate limit past the read's wait answers with the rows sent, none included, without an error. The
  grid reads on from there, under the new revision after a switch. After a release it is `RESULT_RELEASED`.
- **Refusals.** Every other reader of stored pages (`results.view`, distinct values, profiles, search, row identities,
  diffs, pivots, Copy and Save) answers `REMOTE_RESULT` before any work, and so does one whose set switched to windowed
  after that check: the page snapshot, a new view, a lease and an operation's release token refuse a windowed set as they
  take hold, a search or operation whose set switched (even one loaded back since) answers `REMOTE_RESULT`, and a copy
  the switch overtakes is refused rather than cut short. Both codes are in the shared `errorCodes` list. A 404 from `tabledata.list` (BigQuery's
  result table expired) answers `REMOTE_EXPIRED` when the read reaches an uncached block before it has sent any row; a read that sent cached rows first
  answers short with them.
- **`results.remoteQuery { queryId: uuid, resultId, generation, kind: 'load' }`** runs a query over a windowed result
  like `query.execute`: unary with EVENTs, the same summary, stopped by `query.cancel(queryId)`. Main sends it only for a
  result its renderer owns in that generation (else `RESULT_UNAVAILABLE`) and pins the request to it; while the query
  that made the result still runs, or another result of that query is loading (its sets share one budget), the backend
  answers `BUSY`. `load` (Load into
  memory) empties the set and reads the whole table into it under a new revision (`resultSet.residence`), then
  `resultSet.closed`; a refusal part way, a failure or Stop switches it back to windowed, whole, under another revision.
  Closing the result (Close Results, the tab closed or run again) stops the load, whose summary fails with
  `RESULT_RELEASED`; one whose table expired fails with `REMOTE_EXPIRED`, as a read does. Only a windowed result loads (`INVALID_PARAMS` otherwise, as for a second load of one already
  loading; `BUDGET_STOPPED` once the budget has stopped). Main answers `RESULT_UNAVAILABLE` for a result its renderer no
  longer owns, so the backend's `RESULT_RELEASED` reaches only a close that raced past that check.

## Cell lengths and row sizes

While reading a result, the backend measures every stored cell (`Results/CellLengths.cs`): its UTF-16 length
(`LEN(x + 'x') - 1`) and its `DATALENGTH` bytes, including any part of a truncated cell read past. Sort by size, column
statistics and the row-size bar use these; nothing re-reads SQL Server.

- **One helper.** `ResultSetBuffer.CellSize(row, column)` answers `(chars, bytes, exact)`, or null for NULL: a sidecar
  entry's values, else derived from the stored cell by the column's rule. `exact` is false for estimates, for columns
  whose rule is a guess (no collation), and for truncated cells without an entry.
- **Rules per type** (`ColumnLength`): bit, tinyint 1; smallint 2; int, smallmoney, real, smalldatetime 4; bigint,
  money, float, datetime 8; date 3; time 3–5, datetime2 6–8, datetimeoffset 8–10 (by scale); uniqueidentifier 16;
  decimal and numeric 1 + 4 per 32-bit word of the unscaled value; n types 2 per UTF-16 unit; char, varchar, text by
  collation; binary types and CLR types their bytes; json its UTF-8 bytes; vector 8 + 4 per dimension; xml and
  sql_variant as recorded.
- **xml** counts the UTF-16 text SQL Server sends (`DATALENGTH(CONVERT(nvarchar(max), x))`), not its binary storage, so
  such rows differ from `SUM(DATALENGTH(...))`; likewise json. An xml cell's characters are SQL Server's text too
  (bytes / 2), cut or not. **sql_variant** is exact for integers, bit, decimal, real, float, uniqueidentifier and binary
  bases, else an estimate (strings as nvarchar, smallmoney/smalldatetime as 8, date and time types at scale 7); its
  characters are those of the display text.
- **Collation.** Character columns' collations come from SqlClient's metadata by reflection (`SqlClientCollation`,
  `TdsColumnMetadata`); char types count bytes in SqlClient's own encoding, matching `DATALENGTH`. The descriptor column
  gets `collation: { lcid, sortId, codePage, utf8, options }` (`options` SqlCompareOptions bits: 1 IgnoreCase, 2
  IgnoreNonSpace, 8 IgnoreKanaType, 16 IgnoreWidth, 16384 BinarySort2, 32768 BinarySort; `codePage` 0 for UTF-8;
  `sortId` non-zero for SQL_ collations). If reflection fails, no `collation` and one byte per character, as estimates.
- **Column sort kinds.** Every descriptor column carries `sortKind`: `integer`, `decimal`, `float`, `boolean`, `date`,
  `time`, `datetime`, `timestamp`, `binary`, `text`, `json` or `other`, set from its type by `ColumnTypes.SortKindOf`
  (SQL Server: datetimeoffset is `timestamp`, SQL Server's timestamp (rowversion) `binary`, xml `json`, uniqueidentifier,
  sql_variant and CLR types `other`; `tests/fixtures/sort-kinds/sql-server.json`). It is optional in the schema, and the
  renderer derives it from `dataType` with the same mapping (`sortKindOf`, `src/shared/results/sort-kind.ts`) when absent.
- **Storage.** Per sealed page, `PageLengths`: a `uint32` per row (cell bytes summed, NULL 0), a sorted sparse list of
  24-byte `(row, column, chars, bytes)` entries for cells whose stored text does not give their length (truncated, xml,
  vector, sql_variant, estimates; estimates flagged by the column's sign bit), and 16-byte `(row, bytes)` entries for
  rows of 4 GiB or more (`uint32` = `uint.MaxValue`). An unreadable cell (NULL with the error flag) counts 0 bytes as an
  estimate; a row's sum is exact unless it holds an estimate or a column whose rule is a guess. Entries wait until
  `CommitRow`, and a rolled-back row leaves none. Charged with the page: 4 bytes a row, 24 per entry, 96 a page; the open
  page's lengths count in the builder's working space.
- **Reading.** `results.rowBytes { resultId, firstRow, count: 1..16,384 }` answers `{ firstRow, bytes: number[],
  rowsAvailable, estimated: number[] }` for sealed rows only: fewer than `count` past `rowsAvailable` (none for a range
  past it). `estimated` lists, ascending, rows whose sum includes an estimate. Main forwards it only for a result the
  renderer owns in the current, ready generation (else `RESULT_UNAVAILABLE`), and only an answer that passes
  `rowBytesResultSchema`, starts at `firstRow`, has at most `count` and at most `rowsAvailable - firstRow` rows, and lists
  estimated rows in order within them (else `BACKEND_ERROR`). `ResultHandle.rowBytes`
  answers an empty range itself and refuses a malformed one (`INVALID_PARAMS`) without sending it (main closes the port
  after 100 invalid messages).
- **Estimates** also cover: a live table's cut cell (live tables count text as nvarchar, exact; only a cut cell's kept
  text is an estimate), xml without `SequentialXml` internals, and _UTF8 values holding invalid bytes (U+FFFD). A
  code-page value holding bytes its code page does not map is counted as SqlClient decodes it, which no client can tell
  from real text. A fallback-reader value counts as text: exact for character types, an estimate
  for decimal, vector and recorded (xml, sql_variant) types; fixed-size types keep their exact size. Synthetic test rows
  are not measured.

## Messages

The summary's `messages` and the `messages` events carry `MessageEntry { text, kind: 'info' | 'print' | 'server' |
'error', line? }` (`line`: the absolute script line of an error in a submitted batch) in order, under the caps (1,000 entries, 1,000,000 characters); the summary is authoritative. Past the caps,
"Messages were truncated by the display limit; …" marks the cut, and up to 20 more error entries (each ≤ 16,384
characters) are kept, so the error, cancel or timeout that stopped a script still shows. An event carries at most 1,000
entries; a summary at most 1,028 (stored entries, late errors, up to 8 notes). A summary with an `error` but no error
entry gets one added by the renderer.

- **Print:** PRINT (message number 0) and RAISERROR severity 0 – 10 (number 50000 or a user message above it). Shown like
  info; opens the Messages strip, as an error does.
- **Server:** SQL Server's other severity 0 – 10 messages (8153 "Null value is eliminated by an aggregate…", SET
  STATISTICS IO/TIME, DBCC and sp_rename output); shown without opening the strip. 5701 ("Changed database context to
  …") and 5703 ("Changed language setting to …") are left out, as in SSMS.
- **Info:** Varia's lines: row counts as SSMS writes them ("(1 row affected)", "({n} rows affected)", no digit
  grouping), the notes above, the batch-continued line ([Query execution](#query-execution)), and "The SQL session
  closed. …" when an opened session closed.
- **Error:** every severity 11+ error in SSMS's form, `Msg {n}, Level {l}, State {s}, Line {k}` (line within the whole
  script or selection) or `Msg …, Procedure {p}, Line {k}` (the procedure's line), a line feed, then the message. Errors
  arriving with an exception are added unless InfoMessage already delivered them (matched by number, state, line and
  text over the last 20). A cancel adds "The script was cancelled. Remaining batches were not executed.", a timeout "The
  script exceeded its execution timeout. Remaining batches were not executed.", an unexpected stop "Execution stopped
  unexpectedly: …". The summary's `error` keeps the first 20 errors (16,384 characters).
- **`completedAt`** is the backend's local time, `yyyy-MM-ddTHH:mm:ss.fffffffzzz`, for SSMS's "Completion time:" line.
- **`budget`** is `{ usedBytes, globalBytes, queryBytes, seq }` when the summary was built; main adds `generation`; `seq`
  orders it with `results.memory` events ([Global memory events](#global-memory-events)). `stoppedBytes`, present only
  when the query stopped storing for the budget, is the figure at that refusal (its half or an actual plan's ceiling for
  `queryBudget`, the whole budget for `globalBudget`), which the truncation note and grid strip name.

## Sorted views

Grids sort and filter in the backend over the rows it holds (`Results/ResultViews.cs`); SQL Server is never re-read. A
view is an order of some or all of a result's base rows, read through the result's own calls by view position.

- **`results.view { resultId, sort: 0 – 16 keys, filters?: 1 – 16, replaces? }`** answers `{ viewId, rows, baseRows,
  complete, approximate, filters? }`; at least one key or filter. A key is `{ column, descending, mode: 'value' | 'chars'
  | 'bytes' }`, columns distinct and in range (`INVALID_PARAMS`). The view covers the rows sealed when built (`baseRows`;
  `rows` counts what filters kept); `complete`: every row of a finished set (otherwise the view is stale: a filtered
  caption reads "so far" and the renderer rebuilds it when the set completes). `approximate`: a key compared a truncated prefix or an estimated length. `replaces` names a view of the
  same result dropped once the new one is built (left as it was when the sort fails or is cancelled). At most 8 views a
  result; a ninth drops the oldest.
- **Order.** Stable, as ORDER BY: NULL and unreadable cells lowest; exact numerics by value, real/float as doubles,
  uniqueidentifier in SQL Server's byte order, datetimeoffset by UTC instant, other date/time types by fixed-width text,
  binary bytewise, character columns by collation (code points for _BIN/_BIN2) ignoring trailing spaces, other types by
  display text code points. `chars`/`bytes` order character, xml, json (and binary, for `bytes`) by cell length
  ([Cell lengths and row sizes](#cell-lengths-and-row-sizes)); other columns ignore the mode.
- **Progress (`op.progress`).** `results.view`, `.profile`, `.distinct` (open), `.pivot` and `.diff` send droppable
  `{ type: 'op.progress', phase, percent? }` EVENTs (`OperationProgress.cs`). Phases: `filter`, `keys`, `sort`, `unpack`,
  `group`, `aggregate`, `write`, `identify`, `match`, `align`, `profile`, `histogram`; `percent` is of the whole
  operation, 0 – 99, never decreasing, absent for a phase with no total. At most one per 250 ms, none in the first 250 ms
  or after the answer. Main drops an invalid one (`operationProgressSchema`) without failing the request.
- **Filters**, applied in order before the sort, each over the rows the previous kept:
  - `{ op: 'in' | 'notIn' | 'between', column, rows: 0 – 4,096 base rows, nulls? }` compares with those rows' values
    (`nulls`: NULL is among `in`'s and `notIn`'s values). `between` keeps no NULL: with `rows` it takes exactly two rows
    of non-NULL values and no `nulls` (else `INVALID_PARAMS`); from `cells` it keeps the lowest and highest
    value (none but NULL is `INVALID_PARAMS`). Instead of `rows`,
    `cells: { ranges: 1 – 256 [first, count], viewId? }` names selected positions, reduced to one row per distinct value
    (at most 4,096, else `TOO_LARGE`); the answer's `filters` returns the resolved `{ op, column, rows, nulls }` for later
    rebuilds. A resolved value is its lowest base row, so equal filters resolve equally (Pivot relies on this).
  - `{ op: 'groups', column, snapshotId }`: a distinct snapshot's ticks ([Distinct values](#distinct-values)).
  - `{ op: 'duplicates', columns }`: rows whose values in those columns (1 – 4,096, distinct) equal another row's (NULL = NULL), grouped in
    order of each group's first row.
  - `{ op: 'kind', kinds }`: a comparison's rows of 1 – 4 distinct kinds (`same`, `changed`, `added`, `removed`;
    `limits.diff.maxKinds`), read from its change index ([Result diffs](#result-diffs)); both halves of a changed entry
    are `changed`. No `column`, `rows`, `nulls`, `cells`, `columns` or `snapshotId`; `kinds` on another op, or a kind
    filter on a result that is not a diff, is `INVALID_PARAMS`. It answers `{ op: 'kind', kinds }` in that order. It names
    no column, so no header funnel shows it.
  - Equality is the sort's (the collation decides text matches; `2` = `2.0` in float; truncated by prefix, `approximate`).
    A named view that is gone: `VIEW_NOT_FOUND`.
- **Keep Selected Rows.** `{ op: 'keepRows', cells: { ranges: 1 – 256 [first, count], viewId? } }` keeps rows by position,
  not value. Ranges are merged and clipped to the view's rows; more than 4,095 (`limits.transpose.maxRows`) is
  `TOO_LARGE` before reading; none left is `INVALID_PARAMS`.
  It answers `{ op: 'keepRows', rows }` (ascending base rows), the form sent afterwards (`rows: 1 – 4,095`; an unsealed
  row is `INVALID_PARAMS`). It keeps earlier filters' order, and a later filter sees only its rows. Made while rows stream,
  it resolves to rows already sealed, so the view rebuilt once the result completes keeps those and none that arrived
  later. A `column`, `nulls`, `columns` or `snapshotId`, or both or
  neither of `rows` and `cells`, is `INVALID_PARAMS`.
- **Threads.** Keys are built a page at a time and rows sorted in merged slices on several threads, giving one thread's
  order. All running operations (sorts, filters, distinct lists, pivots, profiles, searches, identities, diffs) share the
  worker threads (three quarters of the machine's, at most 16) fairly (`ViewSorter.WorkerGate`, `Results/WorkerGate.cs`):
  - Each runs a step's items on its own thread plus granted workers; shares fill from the smallest demand up. Workers
    start only while fewer than the limit are busy, so busy threads never exceed the limit plus one per extra operation
    (its own); none ever has no thread.
  - Between items a worker over its share hands its thread to the operation furthest below its share; a step out of
    items hands its threads back as its workers find none. So an operation alone gets every thread, and a second gets
    half after the first's next items. Steps are cut finer than the thread count where free (a page an item for keys and
    identities, up to four sort slices or identity-check parts a thread); profiles and searches use one run per thread
    and hand threads back only as runs end.
  - A failure or cancel stops the step's workers at their next item and is rethrown, as itself, once all have stopped and
    disposed their state. A state whose Dispose throws fails the step too, rethrown by the owner only when no body or
    state factory failed and no worker met a cancellation; it stops no other worker and is never thrown on a worker's
    thread. Workers still queued to the thread pool when a step closes are given back at once (never awaited), a lease
    over its share hands back a queued worker before a running one, and a worker the pool refuses counts as never
    granted. A returned step lets go of its body and state, so queued workers hold nothing it captured.
  - The limit is read at each gate event (a lease taken or given back, a step opened or closed, a worker leaving):
    lowering it takes effect at the workers' next items, raising it at the next such event.

  Measurements: [Worker threads measured](#worker-threads-measured).
- **Keys.** `date`, `time`, `datetime`, `datetime2` and `smalldatetime` keys are 8-byte ticks from the fixed-width text;
  a column with a cell written any other way, or of another width than the first, is ordered by its text's bytes instead
  (the same order).
  A byte-ordered key (collation sort key, or raw bytes for _BIN/_BIN2, binary and other text) samples 4,096 scattered
  rows: repeating values are ranked (at most 65,536 ranks, or one per 32 rows) and compared as integers; otherwise it
  keeps 8 bytes per value after the common prefix, plus the rest of each value when 8 bytes do not tell rows apart
  (charged a page at a time, never into the last eighth of the query's or store's room). An operation expected to spend
  about a minute re-reading tied cells is refused with `TOO_LARGE` ("There is not enough result memory to compare this
  much text..."). `results.distinct` and `results.pivot` use the same keys.
- **Memory**, all charged to the query budget (`TOO_LARGE` past it): a sort 8 – 16 bytes per row and key plus 8 a row of
  positions and any key extras; a filter its key per column it compares and 16 bytes per kept row; a view 4 bytes per shown row. Build
  memory returns at once, the order when the view is closed, replaced or released.
- **Reading through a view.** `results.read`, `results.rowBytes`, `results.copy` and `results.export` take `viewId`, with
  rows as view positions; pages are built in view order (flags and truncation kept), cached as
  `generation:resultId#viewId`. Gone: `VIEW_NOT_FOUND`. Copy through a view of a loading set says `partial`; Save refuses
  (`RESULT_OPEN`, "Save the results after they are sorted again.").
- **`results.viewClose { resultId, viewIds: 1 – 64 }`** answers `{ closed }`; a released result's views go with it.
- **Renderer.** `ResultHandle.sort(keys, { filters, replaces, signal })` returns a `ResultView` (`viewId`, `base`,
  `keys`, resolved `filters`, `rows`, `baseRows`, `complete`, `approximate`). `ResultsService` keeps one view per grid
  (a newer sort aborts the running one) and sends no `replaces`: the shown view stays readable until the grid swaps (`viewShown`), then closes. A loading set
  is re-sorted when it completes, and changing Sort text columns by re-sorts text, xml, json and binary keys. Main closes
  a view built after its port went. Copy, Save and opening a value follow the view; Save waits until a running or pending
  sort is built. A filter by the selection sends ranges of what the grid shows (with its view's id) and keeps the resolved
  filter for later views; a failed view keeps the last view, keys and filters.

### Worker threads measured

`--fairness-bench` (`backend/Varia.Backend.Tests/FairnessBench.cs`, run by hand, measures only): 2,000,000 synthetic W1
rows; a sort by `name`, a pivot by `active` and a profile of all columns, alone and in pairs started together. Medians of
7 runs over three rounds on a shared 24-core Windows desktop with the fair gate; a pair shows faster / slower.

| 24 cores, 16 workers | Time |
| --- | ---: |
| Sort / pivot / profile alone | 86 – 164 / 120 – 123 / 225 – 259 ms |
| Two pivots | 141 – 184 / 146 – 188 ms |
| Two sorts | 138 – 142 / 147 – 150 ms |
| Sort, then profile | 261 – 272 / 288 – 331 ms |
| Profile, then sort | 261 – 293 / 270 – 321 ms |
| Sort and pivot | 114 – 121 / 151 – 159 ms |
| Pivot and profile | 244 – 255 / 293 – 307 ms |

| `DOTNET_PROCESSOR_COUNT=4`, 3 workers | Time |
| --- | ---: |
| Sort / pivot / profile alone | 309 – 404 / 253 – 275 / 840 – 1,593 ms (one round 1.6 s, the others 840 – 897) |
| Two pivots | 268 – 487 / 383 – 660 ms |
| Two sorts | 423 – 807 / 609 – 1,166 ms |
| Sort, then profile | 718 – 1,005 / 845 – 2,520 ms |
| Profile, then sort | 705 – 885 / 833 – 2,118 ms |
| Sort and pivot | 369 – 416 / 395 – 504 ms |
| Pivot and profile | 416 – 484 / 798 – 1,120 ms |

Conclusion: against first come, first served, the slower of a pair finishes 1.3 to 2.9 times sooner and an operation
alone is unchanged; at most 17 threads were busy (16 workers and the second operation's own thread). With
`DOTNET_PROCESSOR_COUNT=4` (3 workers) shares are too small to split and totals are about unchanged, with more spread.
`DOTNET_PROCESSOR_COUNT` only tells .NET it has four processors; the threads still ran on 24 cores, so this measures the
gate's sharing, not a four-core machine's speed. "Profile, then sort" gains least, since a profile hands threads back only as runs end.
`--pivot-bench --only parallel` (5,000,000 rows): concurrent builds take 0.76 – 1.1 s each.

## Row identities and highlights

Highlights (Highlight submenu, Ctrl+Shift+H) follow rows by an identity the backend computes (`Results/RowIdentity.cs`);
the renderer never compares rows.

- **`results.identify { resultId, by: 'auto' | 'column' | 'row', column? }`** answers `{ column, unique, approximate,
  rows }`. The set must be complete (`RESULT_OPEN`, "Highlight rows after this result set finishes loading."). `auto`
  takes, of up to 16 candidates (names ending in id, key or guid; then integer, uniqueidentifier, decimal; then short
  character and date columns), the first with no NULL, truncation or duplicate, else the whole row (`column: -1`).
  `column` uses the given one (`unique` reports duplicates); `row` the whole row. An identity is a 53-bit hash of each
  cell's normalized value (collation sort key, trailing spaces trimmed; canonical digits; UTC instant; stored bytes), so
  collation-equal rows match. `approximate`: a truncated prefix was hashed. A second identify replaces the first. It
  keeps 8 bytes a row, charged to the query budget (`TOO_LARGE`) and freed with the result.
- **`results.rowIds { resultId, firstRow, count: 1 – 16,384, viewId? }`** answers `{ firstRow, ids, rows }` (by view position with `viewId`), -1
  past the identified rows; without an identify, `IDENTITY_NOT_FOUND`.
- **`results.findRows { resultId, ids: 1 – 10,000 in 0 – 2⁵³ − 1, viewId? }`** answers `{ positions, marks, truncated,
  rows }`: ascending positions (view positions with `viewId`) of matching rows, each with its index in `ids`, at most 100,000 (`truncated`).
- **Renderer.** `HighlightsService` keeps highlights per tab and result (a re-run's result of the same number takes them
  over and is identified the same way). Searches failing with `BUSY`, `TOO_MANY_REQUESTS` or `TIMEOUT` retry after 1, 4
  and 16 s. At most 10,000 rows per command and per set. Highlights live only in renderer memory.

## Result diffs

Compare with Previous Result and the Compare popover compare two results of one query in the backend
(`Results/ResultDiff.cs`), producing a new result. The renderer runs at most four comparisons per window (`DerivedJobs`,
shared with Pivot) and retries `TOO_MANY_REQUESTS` or `BUSY` after 1, 4 and 16 s.

- **`results.diff { left, right, exact?, context?, match?, layout?, replaces? }`** answers `{ descriptor, match, same,
  changed, added, removed, soft, approximate, leftOnly, rightOnly, repeated, possible, possibleSkipped, nothingPaired,
  columnChanges, trailingHidden, overview, units, layout }`. `layout` is `unified` (absent: two rows a change) or `entry`
  (one row an entry, below); any other is `INVALID_PARAMS`, and the answer says which was written. Both must be the same query's own `rows` sets (`INVALID_PARAMS`, "Only a query's
  own result sets can be compared: not a pivot, a comparison or an execution plan set."), complete (`RESULT_OPEN`,
  "Compare the results after they finish loading."), and the query must not have stopped storing (`BUDGET_STOPPED`, see
  [Pivots](#pivots)). Columns pair by name case-insensitively (`src/shared/ordinal-casing.ts`), in `left`'s order, when
  both are text or both binary, repeats pairing with the next unused one (`tests/fixtures/compare-pairing/cases.json`).
  1 to 4,092 must pair (`INVALID_PARAMS`); `leftOnly`/`rightOnly` name up to 64 unpaired columns, not compared.
- **Match modes.** `match` is `{ mode: 'auto' }` (absent: auto), `{ mode: 'position' }`, `{ mode: 'rows' }` or
  `{ mode: 'columns', columns }` with 1 to 16 distinct pair indexes, each below the pair count (`limits.diff.maxKeyColumns`;
  zod, then the backend, `INVALID_PARAMS`). `auto` matches by the first shared column unique, NULL-free and untruncated in
  both (ranked as `results.identify` does), else by whole rows; `rows` by whole rows (all pairs together); `columns` by
  the chosen pairs together, NULL matching NULL; `position` the n-th row of each with the n-th, the rest added or removed.
  A key or whole row met more than once matches in order, k-th copy to k-th copy. A chosen key column holding a truncated
  value is refused with `DIFF_KEY_TRUNCATED` ("A key column holds values too long to compare. Choose another."). Values
  compare by `left`'s type and collation (its sort kind: floats and binary by exact value). Collation-equal but not
  identical text is a soft difference (row unchanged, counted in `soft`); `exact` compares character for character.
  `approximate`: a truncated prefix was compared.
- **The answer.** `match` is `{ mode, columns }`, what matched rows: `auto` with its key column's name, `rows` when
  asked or when auto found no key, `position`, or `columns` with the key columns' names (`right`'s). `repeated` counts
  entries whose key occurs more than once on either side (only `columns` can have them; flagged `dup`). `possible`
  counts possible matches: after alignment (not `position`), removed and added rows are compared over the pairs that did
  not match rows (all pairs for whole rows; none left when every pair is a key, so nothing is sought); a pair qualifies
  when at least 75% of those columns are equal as the cells compare (NULL equal to NULL; with `exact`, text equal only
  by its collation is not) and at least min(3, columns) of the equal values are not NULL, and is kept only when each is the other's unique best (a tie on either side keeps neither). Counts and colours
  never change. `possibleSkipped`: more than 1,000 removed or added rows, more than 4,000,000 comparisons (removed ×
  added × columns), or the values' working memory refused. `nothingPaired`: both inputs have rows and none matched.
  `columnChanges`: each pair's `{ changed, soft }` cells, in pair order (the true counts, whatever a cut tone lists).
  `trailingHidden`: unchanged entries left out after the last stored row (with `context` ≥ 0). `overview`: up to 512
  buckets (`limits.diff.overviewBuckets`; one a row when fewer rows are stored, empty for none) over the stored rows in
  order, each the bits of the kinds in it: 1 changed, 2 added, 4 removed. `units`: the stored rows' change units (below).
- **The change index** (`Results/DiffIndex.cs`) is built with the stored rows and kept with the diff until it is
  released. Per stored row: its kind (both halves of a changed entry are `changed`), whether its key repeats, whether its
  tone was cut, and its change units: each changed cell the tone lists, plus one for a cut tone, on a changed entry's
  `changedNew` half (its `changedOld` half has none); one for an added or removed row; none for an unchanged row (soft
  cells are not changes). Running totals of units every 4,096 rows (`limits.diff.indexBlockRows`) let a seek skip empty
  stretches. A look-alike row holds its partner as a stored row (none when the partner was not stored). In the one-row
  layout a changed row is one entry with the units of its listed cells (plus one when cut), and each cut row keeps its
  full list of changed pairs as a bitset (4 bytes plus 8 per 64 pairs), found by stored row through a sorted list of cut
  rows, so Save can write every changed cell's old value. It is charged to the query's budget before the rows are
  written (a cut row's bitset as it is met), and refused with the diff. A view of a diff keeps its own running totals
  over its order, charged with the view.
- **`results.diffSeek { resultId, viewId?, from, direction }`** (`direction`: `next` or `previous`; `from`: a position,
  -1 before the first) finds the nearest row with change units after or before `from`, wrapping round, in stored order
  or the view's. It answers `{ row, column, index, total, rows }`: the position, the column to land on (the first listed
  changed cell going forward, the last going back; 0 for an added or removed row, or going back onto a cut row), the
  1-based unit it lands on among the `total` units of the rows shown (the row's first unit going forward, its last going
  back), and the rows shown, or `{ none: true }` when no row shown has a change. It steps by row: moving between one
  row's own units is the renderer's, from the tone it has read, numbering them from the row's `index`.
  **`results.diffSeek { resultId, viewId?, partnerOf }`** answers the look-alike partner of the row at that position:
  `{ row, column: 0, index, total, rows }`, `{ hidden: true }` when the view does not show the partner, or
  `{ none: true }` when it has none (or the position is past the end). Main refuses an answer whose `row` is not below
  `rows`, `hidden` to a seek, or a partner off the first column (`BACKEND_ERROR`). Both forms on a result that is not a
  diff are `INVALID_PARAMS`, on a released one `RESULT_RELEASED`; both engines.
- **The unified result** (`kind: 'diff'`, stamped with the generation and owned by main) is in the later result's order,
  each removed row after the row it followed, a changed row as old (−) then new (+). Columns: the shared columns with
  `right`'s names and types (the data columns, in pair order), then a hidden suffix: `Change` (role `mark`: " ", "−",
  "+"), `Old row` and `New row` (roles `leftRow`, `rightRow`: bigint, the 1-based row in each input, NULL where the entry
  has none; both halves of a changed entry carry both), and an `nvarchar(500)` tone (role `tone`): `<kind> [flag…] [cell…]`.
  Kinds: `same`, `added`, `removed`, `changedOld` and `changedNew` (a changed entry's − and + halves), and `changed`
  (the one-row layout's changed entry, marked `~`). Flags, at most 3 and 34 characters: `dup` (the key repeats; both halves),
  `poss=<row>` (on `added`/`removed` only: the possible match's 1-based row in the other input) and `gap=<n>` (the
  unchanged entries left out just before this row, under any `context` but -1, absent when 0; on a change, its
  `changedOld` half). Readers ignore unknown flags. Then the differing cells as pair indexes, which are the data columns' indexes, soft ones `~`, runs as
  `first-last` (`changedOld dup 0-5 ~7`); the cells are cut at a whole entry with ` …` so the whole text, kind and flags
  included, is at most 500 characters. An unchanged row with no flags and no soft cell has a NULL tone. Hidden columns (`old`, `mark`, `leftRow`, `rightRow`,
  `tone`; a previous value's `of` names its pair) are not data: `results.view` sort keys and filters, `duplicates`
  columns, `results.distinct`, `results.profile` and `results.identify`'s `column` refuse them (`INVALID_PARAMS`), search
  and Copy skip them, and Save writes `Change`, `Old row`, `New row` as its first columns for a diff only, and each
  shown data column's previous values after it as `<name> (old)` (a transposed Save of a diff is `INVALID_PARAMS`). `results.identify` on a diff refuses `by: 'column'`; `auto` and `row` answer
  column -1 with one identity per entry, a hash of its (input result id, row) pairs ordered by input id, so both halves
  share it, `unique` counts entries, and it survives a swap of the same inputs. `context` unchanged rows show each side
  of a change (default 1, at most 100, -1 for all). Data cells keep their source lengths for `results.rowBytes`; the
  suffix is not measured, so a row's bytes are its shown values'. It is a derived set
  (`ResultStore.Open(derived: true)`) charged to the query's budget and stored whole or not at all (`TOO_LARGE`, "There is
  not enough result memory to show the differences. Close other results and try again."; the query is not stopped),
  released with the query's results or at once when its answer is not delivered. When what was refused grows with the
  rows stored (the rows, their previous values, the change index or a cut row's bitset) and `context` is -1 (All rows),
  the refusal is `DIFF_ROWS_TOO_LARGE` ("There is not enough result memory for all rows of the differences. Show changes
  only, or close other results and try again."), which Changes only may fit; with any other `context`, for the
  alignment's working memory and for other causes it stays `TOO_LARGE` (low system memory: its own sentence). A source
  released meanwhile:
  `RESULT_RELEASED`. Building holds about 74 bytes a left row and 36 a right row (`ResultDiffer.WorkingBytes`) plus 12 bytes per
  differing cell, charged to the budget as they grow (`TOO_LARGE` without room); a `columns` match adds 9 bytes a row to find
  repeated keys, and the look-alike search 9 bytes a value it reads (refused: the search is skipped). Work is split across
  threads with one thread's result.
- **The one-row layout** (`layout: 'entry'`): the same entries and suffix, a changed entry as one row (mark `~`, tone
  `changed`, both row numbers) of the new values. After the data columns come previous-value columns, one a pair (role
  `old`, `of` its pair, named `<name> (old)`), with `left`'s type, collation and length rule: the old value in every
  changed (not soft) cell, listed by the tone or past its cut, NULL elsewhere. They are not measured for
  `results.rowBytes` but count toward the 8 MiB row limit; past it a value is stored truncated and marked. Data, previous
  values and suffix must fit a page's 4,096 columns, so more than 2,046 pairs (`limits.diff.maxEntryPairs`) is
  `INVALID_PARAMS`; the renderer asks for two rows itself then.
- **Replaces** (`replaces`: a comparison's result id): the new comparison is written under an allowance of the replaced
  one's charge ([Result store and memory budget](#result-store-and-memory-budget)), kept by the new comparison until
  either is released. It must be a comparison of the same query and the same two inputs, in either order
  (`INVALID_PARAMS`; released: `RESULT_RELEASED`). Main forwards it only for a comparison its port owns whose recorded
  inputs are the request's, either way round (`RESULT_UNAVAILABLE` for a result that is not a comparison it owns, `INVALID_REQUEST` for other
  inputs); the record belongs to the page that made the comparison, so the next page load cannot replace it, while a
  port reopened within the page (popped-out panes use the window's port) still can. The caller releases the old
  comparison once the new one is shown.
- **Renderer.** `CompareService` appends it as the run's last set ("Differences: Result 1 → Result 2"); a change of it
  (Layout, Exact text, swapped sides) replaces it in place under the same entry (`replaceComparison`). A new run in the
  tab gives up a comparison in flight, and `addSet` takes a diff only into the run that holds both compared sets; one it
  refuses is released. `GridView`
  colours rows and cells from the tone column (`is-chg`, `is-soft`, `resultsGrid.diff*`): its kind is the row's tone (the
  kinds join `rowTones`; no live tone uses them), and a `changedOld` or `changedNew` half colours its changed cells alone. The colour is each cell's background colour, under translucent highlight, search-match and selection layers
  in that order (`styles.css`, pinned by `tests/results-diff.test.ts`). It also draws each row's gutter
  from the suffix it reads with every row tile (`GridData`'s suffix tiles): a kind bar, the mark and the row's number in
  its own input (the old input's on a − row), then ≈ for a repeated key, else ? for a possible match, named for screen
  readers and in the tooltip ("Removed, repeated key, possible match with row 12 in Result 2; row 3 in Result 1"); a cut
  tone's name ends "More changes in this row are not listed". The strip says how rows matched ("rows matched by Id,
  Status", "rows matched by position", "whole rows matched").

## Pivots

Pivot groups and aggregates a result's rows in the backend (`Results/ResultPivot.cs`), producing a new result.

- **`results.pivot { resultId, rows, column?, values, viewId? }`** answers `{ descriptor, rows, rowGroups, columnGroups,
  approximate }`. `rows`: 0 to 8 distinct row-group columns; `column`: an optional column-group column not among them;
  `values`: 1 to 16 `{ aggregate, column? }` with aggregate `count`, `countDistinct`, `sum`, `avg`, `min` or `max` (only
  `count` may omit the column: COUNT(*)). `sum`/`avg` need a non-bit numeric column (`INVALID_PARAMS`, "Sum and Average
  need a numeric column."). The result must be complete (`RESULT_OPEN`) and a query's own rows (`INVALID_PARAMS`, "Only a
  query's results can be pivoted."). Through a view it reads the view's rows; `rows` counts rows read.
- **Grouping** is GROUP BY's, by the sort's comparison; groups ascend, NULL its own group first. `approximate`: a
  truncated prefix took part.
- **Aggregates.** COUNT non-NULL values (or rows); COUNT DISTINCT distinct non-NULL values; MIN/MAX by sort order, copied
  with type and collation. SUM of tinyint–bigint is bigint, of other exact numerics decimal(38, s) exact to 38 digits
  (`ResultPivoter.TryScaled`); AVG of exact numerics decimal(38, max(s, 6)), rounded half away from zero; floats as
  float. An empty cell is 0 for a count, NULL otherwise; overflow is an error cell.
- **The pivot result** (`kind: 'pivot'`, owned by main as a diff is): row-group columns, then per column group each
  value, named by the group's value ("NULL", "(blank)", binary as `0x` hex, cut to 128 characters with "…", collisions
  " (2)", " (3)") or "group · Sum of Amount" with several values, then a `Total` per value. Names are unique ignoring case
  (`PivotOutput.Unique`). Without a column group values are named alone ("Count of rows"); without row groups, one row.
- **Bounds.** At most 256 column groups (fewer past a page's 4,096 columns), 100,000 row groups and 4,000,000 figures,
  checked once groups are known and never shown in part: `INVALID_PARAMS` naming bound, count and remedy ("The column
  group has 1,204 distinct values, and a pivot can have at most 256 column groups. Choose a column with fewer values, or
  move it to Rows."). The messages name no column or value. Main checks the answer's shape (one row per row group; row columns + (column groups + 1) × values).
- **Memory and stopped queries.** A derived set of the source query, charged to its budget, stored whole or not at all
  (`TOO_LARGE`), released as a diff is; a refusal never stops the query. Grouping holds
  `ResultPivoter.WorkingBytes` (the sort keys + 12 bytes a row). Figures (4 to 25 bytes per cell and value; COUNT
  DISTINCT adds 4 bytes a cell, charged with them) are charged before computing (`TOO_LARGE`, "There is not enough result memory to
  pivot these rows. Close other results and try again."). A query that stopped storing stores no pivot or diff: `BUDGET_STOPPED`, with one of:
  - query budget filled: "This query's results filled its result memory, so it can store nothing more. Run the query
    again returning fewer rows."
  - global budget filled: "The result memory filled while this query ran, so it can store nothing more. Close other
    results, then run the query again."
  - low system memory at a page seal: "The computer was low on memory while this query ran, so it can store nothing more.
    Run the query again."

  A row limit never stops the query. A source is complete while its query may still be reading later sets: a pivot or
  diff refused memory for its figures or differing cells, not opened, or cut short, because its query stopped storing or
  a source was released while it was built, answers `BUDGET_STOPPED` or `RESULT_RELEASED`, not `TOO_LARGE`. The worker's `cancel` stops it (`CANCELLED`).
- **Renderer.** `PivotService` keeps each group's draft and shows "Pivot of Result N"; a rebuild replaces it atomically
  (the old one stays readable meanwhile, so the budget holds both; `addSet` reuses the slot, `revision` counts builds).
  Builds go through `DerivedJobs`, retrying `BUSY`/`TOO_MANY_REQUESTS` (never `TIMEOUT`). A build holds the Table's view
  (`ResultsService.holdView`) and rebuilds once after `VIEW_NOT_FOUND`. A run holds at most 1,000 results. A new run, the
  Table closed or the Pivot being replaced closed gives a build up, and an answer that comes anyway is released
  (`ResultsService.discard`). A re-run keeps
  the draft, remapping columns by name (`remapDraft`).

## Transposed

Transposed is how a grid is drawn (columns as rows), not a result: nothing is requested or stored. The protocol carries:

- **Copy and Save** of a transposed grid: `transposed` and `headerColumn` on `results.copy` and `results.export`
  ([Transposed text](#copy-and-save-results-as)).
- **The cap.** The view's first 4,095 rows (a page's 4,096 columns less the name column): `limits.transpose.maxRows`,
  `ResultTextWriter.MaxTransposedRows`; also the `keepRows` bound.
- **`results.transpose` was removed**: absent from HELLO, answered `METHOD_NOT_FOUND`, refused by the port, and no
  descriptor has `kind: 'transpose'` (`tests/results-transpose.test.ts`). Main and backend ship together, so removing a
  method needs no version change.

## Search in results

The results toolbar's search runs in the backend over held rows in the grid's order (`Results/ResultSearch.cs`).

- **`results.search { resultId, text: 1 – 1,024 characters, fromRow, maxMatches: 1 – 10,000, backward?, viewId? }`**
  answers `{ rows, total, first, matchRows, matchColumns, complete, approximate }`, over the rows sealed now or a view's
  positions (`VIEW_NOT_FOUND`), in parallel runs (one per 32,768 rows). It counts every match (`total`) and returns whole
  rows from `fromRow` on (with `backward`, the last rows before it) until it holds `maxMatches`, so a run passes
  `maxMatches` by at most its last row's columns (main accepts up to `maxMatches` + `page.maxColumns`). `matchRows[k]`/`matchColumns[k]` are
  cells in row, column order; `first` counts matches before the run (or before `fromRow` when empty). `complete`: the rows searched were
  every row of a finished set; `approximate`: a truncated prefix did not match. It reserves no budget (at most 1 MiB of page layouts), except one- or two-page rooms to
  read a packed result and, through a view far from a packed result's pages (a sort), the view's inverse, 4 bytes a row of the result (not of the view),
  as it reads that result in page order instead of unpacking it (`TOO_LARGE`), and the memo it keeps for narrowing (below). CANCEL (a newer search), the result's release (`RESULT_RELEASED`) or the view's
  close (`VIEW_NOT_FOUND`) stop it at the next checkpoint.
- **Matching.** A cell matches when its grid text contains the text; NULL, unreadable and hidden columns never match.
  Character columns compare as `LIKE '%text%'` under their collation (code points for _BIN/_BIN2); text of only
  locale-ignored characters (U+200B, U+00AD) matches by code point. Other columns compare display text ignoring case;
  binary matches `0x` and hex, skipped when the text is not hex.
- **Pre-check.** A culture compare (ICU) reads text that is not ASCII at about 90 MB/s, so a character column of a
  verified culture first folds the cell with the culture's search fold for the column's options (`SearchFold`: each
  character mapped to one representative of the characters its collator gives the same sort key under those options,
  built in 0.05 – 0.1 s on first use, off the search) and looks for the text's fold by code point; only a cell holding it
  goes to the compare. The answers are the compare's, about 3.3 times sooner over SQL Server's own messages in 22
  languages. Collation is not always per character (Japanese ー repeats the sound before it, l·l joins, ligatures and
  presentation forms equal letter pairs), so the fold vouches only for an allowlist of characters whose collation depends
  on no neighbour (`SearchFold.Vouched`: Latin, Greek, Cyrillic, Hebrew and Arabic letters, kana, CJK ideographs, Hangul
  syllables, full-width forms, after NFC); a cell with any other character (Thai, Indic, ligatures, a supplementary
  character) goes to the compare alone, and a matcher stops pre-checking once more than 60 % of its first 1,024 cells
  pass. A fold is per option set because options are not monotonic: Estonian finds Ｚ in Z case-sensitively but not
  case-insensitively, and ignoring accents the compare ignores case too (so those keys do). Danish, Norwegian, Hungarian
  and Croatian collations are never pre-checked (they treat a letter as a pair of letters), nor is Thai (its compare
  finds characters its sort keys tell apart). `SearchFoldChecks` compares every verified culture's answers with the
  compare's over fuzzed text and known context-dependent cells under four option sets, checks that strings with the same
  key fold alike, and asks the compare itself about pairs of sample characters under all sixteen option sets for root
  and the cultures that tailor Latin, kana or Arabic (an out-of-tree scan covers every verified culture). The column
  filter's value search uses the same matcher.
- **Page filters** (`Results/PageFilter.cs`). Packing a page of 32 KiB or more also builds a filter for each searchable
  column: which ASCII characters its cells hold (and whether any other), and a Bloom filter of its trigrams (4-grams for
  binary and `uniqueidentifier`, whose hex holds every trigram; two hashes, at the smallest power-of-two size up to 16 KiB
  its grams leave at most 40 % full, left out when fuller) in the matcher's own compare space: code points for _BIN/_BIN2, .NET's ignore-case classes
  for no collation and for binary's `0x` hex, and the culture's search fold for a verified culture (packing waits for the
  fold's first build, so a page packed before any search still gets the column's filter). A text of 4 or more
  characters that a page's filter rules out in every searched column cannot match there, so the search passes the page
  over without unpacking it. A column of only NULLs on the page rules any text out; a column with a cell the fold does
  not vouch for, or of a culture without a fold, has no filter and the page is read. A page passed over that holds a
  truncated cell keeps the answer `approximate`; through a view such a page is read, as the view may leave that row out.
  Ruling out by filter is ruling out by fold, so a narrowed search after it must meet the fold rule (below). A filter is
  charged to the budget with its packed page ([Charges](#result-store-and-memory-budget)), dropped when the page is
  unpacked and freed with its result. It takes at most an eighth of the page's packed bytes, and never so much that the
  page with it saves under a tenth (a page of GUIDs or random text would otherwise cost more than it saved): over that,
  the largest gram filters are left out, then the whole filter. Over SQL Server's messages in 22 languages (200 packed pages, 50 MB), filters take
  2.8 KiB a page (4.6 % of the packed bytes) and build at about 240 MB/s on the packer's thread; specific words pass over
  40 – 66 % of the pages (8152, xp_cmdshell, Datenbank, データベース: Find 1.3 – 1.9 times faster), common words
  (database, error) none, and pages holding cells the fold cannot vouch for (Thai, Indic, Chinese punctuation) are always
  read. `PageFilterChecks` compares filtered searches with reading every page over fuzzed multilingual pages, in base
  order and through filtered and shuffled views, both ways and while typing, and checks the budget to the byte; the
  packed pass of the .NET checks gives every page a filter however small.
- **Narrowing while typing** (`Results/SearchNarrowing.cs`). Each search keeps a memo on its result: its text, view and
  rows, what each column's ruling out needs, and two bits a position (matched; did not match but must be looked at
  again). The next search reads only the matched positions when its text is the same (Find Next and Previous), or the
  matched and recheck positions when its text holds the last one anywhere (typing on, or a key typed in front), with no
  protocol change; positions sealed since are read in full. "Whatever holds `abcd` held `abc`" is false under a
  linguistic compare (combining marks, expansions such as ß and ﬁ, jamo, ignorable characters, contractions such as
  Czech ch), so a culture column's cell that did not match is passed over only when one of two rules ruled it out:
  - **Pre-check:** its fold lacked the text's fold. The pre-check is sound and folds go character by character, so the
    cell is ruled out for any later text whose fold holds this text's fold (checked when that text is searched).
  - **ASCII:** the cell and the text are ASCII and the culture joins no two ASCII characters into one letter, found by
    asking its collator about every ASCII pair (Czech and Slovak ch, Albanian, Welsh, Serbian Latin, Danish, Norwegian,
    Hungarian, Croatian; triples found nothing more) or by rule (Thai); a later text must be ASCII too. Used without a
    fold, or when the pre-check stopped for most cells passing it; a narrowed search keeps pre-checking.

  Any other cell that did not match (one the fold cannot vouch for that is not ASCII) is looked at again. Ordinal and
  binary columns narrow freely; a column whose compare changes kind (text of only ignorable characters is searched by
  code point) does not narrow. A truncated cell that did not match in a row passed over still makes the answer
  `approximate`, so when there was one, a binary column that the new text no longer matches (hex text grown a non-hex
  letter) means a full search. The memo is spare memory (`TryReserveSpare`: never the budget's last eighth; none without room, and the
  search still answers), replaced by the next search's, and freed with its result (re-execute, Close Results, tab close,
  backend loss). Typing a word into all 367,576 of SQL Server's messages takes 1.4 – 1.8 times less time than searching
  every row each key (2 – 5 times over the English ones, 85 – 100 % saved a key from the third on); Japanese and Chinese
  messages, whose punctuation and ー the fold does not vouch for, gain nothing. The first key or two cost up to a few
  milliseconds more (the memo, and pre-checking on). `SearchNarrowingChecks` types random keys (on, in front, backspace,
  Find Next) into results of eleven collations, in base order, through a sort and a filter, packed and not, dense and
  one cell a row, and while a result loads, and compares every answer with a search of every row; breaking any rule
  above fails it. The value search narrows its distinct values the same way from the last search's marks, which its
  snapshot already charges; over a packed result it reads them in the row order its first search kept, so a key that
  keeps most values costs no more than a search of every value.
- **Main** checks the answer: equal row and column counts, cells strictly ordered within the rows searched and on the
  asked side of `fromRow`, columns in range, `first + matches ≤ total`.
- **Renderer.** `ResultsSearchService` (`results/search.ts`) searches after a 200 ms pause (Enter at once), one grid at a
  time, each holding one run of up to 10,000 matches. Columns mode matches names locally. Find in Results (Ctrl+F),
  Find Next / Previous in Results (F3, Shift+F3) are catalogue commands.

## Column profiles

The column profile panel and the row-size bar use `results.profile`, which answers aggregates, never rows
(`Results/ColumnProfiles.cs`).

- **`results.profile { resultId, columns: 0 – 32, viewId? }`** answers `{ rows, complete, rowBytes?, columns }`. Columns
  distinct and in range (`INVALID_PARAMS`); none answers only `rowBytes`. Through a view it describes the view's rows,
  else the rows sealed now. Main forwards an answer only when it names the asked columns in order.
- **Per column** `{ column, values, nulls, distinct, distinctExact, min?, max?, approximate, chars?, bytes?, histogram? }`,
  compared as a sort does (NULL and unreadable cells count as `nulls`, never `min`/`max`; 1.50 = 1.5). `distinct` is exact to 16,384 values, then a HyperLogLog
  estimate (about 1 %, `distinctExact: false`). `min`/`max` are display text (binary as `0x` hex) cut to 256 characters with "…"; `approximate`: a truncated
  cell's stored prefix took part. `complete`: the rows described were every row of a finished set. `chars` and
  `bytes` (`{ min, max, average, exact }`) come from stored lengths: text, xml and json get both, binary only `bytes`. `histogram`
  `{ basis, low, high, counts }`: 20 equal buckets by `value` (numbers), instant (dates; `time` in .NET ticks), `chars`
  (text) or `bytes` (binary).
- **`rowBytes`** `{ min, max, average, exact }` from page row sums; the row-size bar scales to `max` once the set is
  complete (asked again 2 s after a failure), or to the largest row read while that is larger.
- **Rows, not order.** Figures are order-free, so the panel (`ColumnProfilePanel.tsx`, `profiledRows`) keys a profile to
  the result, the view's resolved filters (`sameFilters`) and the rows they were applied to: a re-sort sends no request. A view it is reading stays open
  (`ResultsService.holdView`) until its answer arrives.
- **Work.** Two parallel passes over sealed pages (results equal one thread's). Working memory (a bit a row, per column
  and thread an exact distinct set to its cap, 16 KiB of estimator registers) is charged to the query budget
  (`TOO_LARGE`), falling back to half the threads' share, down to one thread's, when the budget has no room. Long
  min/max and collation keys are charged as met, and a refusal ends the profile `TOO_LARGE`. With no columns only row sums are read. `cancel` stops it (`CANCELLED`).

## Distinct values

The header funnel lists a column's distinct values with counts from a snapshot the backend keeps with the result
(`Results/DistinctValues.cs`), read at most 512 values a window, bounded only by the query budget.

- **`results.distinct { resultId, column, viewId?, keptViewId? }`** answers `{ snapshotId, rows, complete, nulls,
  distinct, approximate, checked, nullsChecked }` (`INVALID_PARAMS` for a bad column; `VIEW_NOT_FOUND` for a gone view).
  `complete`: the rows grouped were every row of a finished set. NULL and unreadable cells count in `nulls`. At most 24 snapshots a result (`TOO_LARGE`), released with it, on
  re-execute and by `results.distinctClose`.
- **Values.** Equality is the filters'. `row` is a value's lowest base row, `group` its place in value order, `text` its
  display text cut to 256 characters with "…".
- **Ticks.** One per value and one for NULL. All start ticked, or with `keptViewId` (another view of the result) only
  values some row of that view holds; rows sealed after that view start ticked.
- **`results.distinctRead { resultId, snapshotId, order: 'count' | 'value', offset: 0 – 2³¹, count: 1 – 512, search?:
  1 – 1,024 characters }`** answers `{ total, offset, values: [{ group, row, text, count, checked }], checked,
  nullsChecked }`; `count` order is most frequent first, ties in value order; `search` matches as [Search in
  results](#search-in-results) does, `total` then counts only the matches, and they are kept for scrolling.
- **`results.distinctTick { resultId, snapshotId, checked, groups?: 1 – 512, all?, search?, nulls?, order?, ranges?: 1 –
  512 [offset, count], toggle?, invert? }`** sets ticks of the named groups, all values (or all `search` matches), the
  values at `ranges` (sorted and disjoint) of the list in `order` (searched with `search`), or flips every value (`invert`), and NULL; one of
  those at most. `toggle` (with `ranges`) ticks them all when any, or NULL when `nulls` is given, is cleared, else clears
  them all, NULL alike, ignoring `checked`. Answers `{ checked, nullsChecked }`. A range past the list's end or a frozen
  snapshot is refused (`INVALID_PARAMS`).
- **`results.distinctClose { resultId, snapshotIds: 1 – 64 }`** answers `{ closed }`; ids already gone are skipped. A
  closed snapshot asked for again answers `VIEW_NOT_FOUND`.
- **Filter.** The first `results.view` using `{ op: 'groups', column, snapshotId }` freezes the snapshot: `in` of the
  ticked values' rows when complete and ticked ≤ cleared, else `notIn` of the cleared (so arriving values stay shown). It
  resolves to `{ op: 'groups', column, snapshotId, keep, values, nulls, row?, digest }`; `digest` is 32 hex digits (half a
  SHA-256 of column, keep/drop, NULL and frozen rows), equal for equal ticks over equal rows, which Pivot compares. A sort or another filter builds the view again from the same
  frozen snapshot.
- **Memory.** `DistinctWorkingBytes` (about 65 bytes a row) while building, `DistinctSnapshotBytes` (30 bytes a value plus
  4 KiB) while kept, both on the query budget (`TOO_LARGE`). `cancel` stops a build or read (`CANCELLED`). Main checks
  answers (rows below 2³¹, `checked` ≤ `distinct` ≤ `rows`, `nulls` ≤ `rows`, exactly `min(count, total − offset)`
  values, at the offset asked) and closes a snapshot built after its port went.
- **Renderer.** `ColumnFilterPopover` lists the snapshot over the rows the grid's other filters keep, as a virtualized
  checklist with backend search, an action list (every value, the matches, the selected rows as ranges), NULL, and custom conditions (equals, does not equal, between, is
  NULL, is not NULL); OK hands it to the grid as a `groups` filter in the replaced filter's place. The grid keeps the snapshot while a filter
  names it and closes it once the view it shows no longer does; a popover closed without OK closes its own. Keep Selected Rows
  (`ResultsService.keepSelectedRows`) is no column's filter, one per grid, counted among the 16; more than 4,095 rows or
  256 ranges is refused in the toolbar.

## Copy and Save Results As

All Copy and Save text comes from `ResultTextWriter` (C#), reading stored pages in place through `PageView`
(`Varia.Backend.Tests/PageReader.cs` is the independent oracle). It works on UTF-8 bytes: every byte needing quoting or
escaping is ASCII (plus U+2028/U+2029 as their three bytes).

| | Copy (TSV) | Save TSV (`.txt`, `.tsv`, `.tab`) | Save CSV (`.csv`) | Save JSON (`.json`) |
| --- | --- | --- | --- | --- |
| Encoding | UTF-8 to main, then the clipboard | UTF-8 with BOM | UTF-8 with BOM | UTF-8, no BOM |
| Separator, end of line | TAB; CRLF on Windows, LF elsewhere; none after the last line | TAB; CRLF after every line | `,`; CRLF after every line | `[` LF, one compact object per line joined by `,` LF, then LF `]` LF; an empty result is `[]` LF |
| Header | Copy with Headers, or Copy with `queryResults.grid.copyColumnHeaders` on (off by default); one header line per part | with `queryResults.grid.saveColumnHeaders` (on by default) | same | object keys |
| NULL and read errors | `NULL` | `NULL` | empty field | `null` |
| Text | CRLF, CR, LF, TAB and NUL each become one space (Windows ends clipboard text at a NUL) | CRLF, CR, LF and TAB each become one space | quoted when it holds `,` `"` CR or LF, `"` doubled, line breaks kept; an empty string is `""` | a JSON string: `"`, `\`, C0, U+2028 and U+2029 escaped, everything else raw |
| Binary, CLR types | `0x` + uppercase hex | same | same | `"0x…"` |
| Numbers | display text | same | same | tinyint, smallint, int, bigint, decimal, numeric, money, smallmoney, real and float as the display text when it is a JSON number of at most 15 significant digits, otherwise a string; bit as `true`/`false`; everything else a string |
| Column names | blank → `(No column name)` | same | same, as a field | blank → `Column{ordinal}`; repeats get `_2`, `_3`… |
| Truncated cells | the stored prefix, counted in `truncatedCells` | same | same | same |

`exportDefaults` (`src/main/results-jobs.ts`) sets the saves' `headers` and `nullText`. Golden bytes:
`tests/fixtures/results-text/cases.json`, checked against the C# writer (`TextChecks.cs`) and the fake backend's twin
(`tests/results-text.test.ts`).

**Transposed text.** `transposed: true` writes column-major, as a transposed grid is drawn, in every format.

| | Transposed |
| --- | --- |
| Lines | One per source column, each with one field per source row; a JSON save is one object per source column. |
| Rows written | View positions 0 to 4,094 (`limits.transpose.maxRows`); rows past them are counted in `capped`; a part wholly past them writes no values. |
| Headers on (Copy with Headers, saves with headers, JSON always) | A first line `Column`, then one name per row; each line starts with its column's name (blank → `(No column name)`, in JSON too, unlike the untransposed `Column{ordinal}`). |
| Field names | `Row N` (view place from 1, no grouping), or with `headerColumn` that column's header text: `NULL` (also a read error), `(blank)`, binary as `0x` hex, line breaks/TAB/NUL as one space, at most 128 characters (no split surrogate pair), then made distinct with `_2`, `_3`… (`Column` included). |
| Headers off | Values only; `headerColumn` changes nothing; a part with no rows writes nothing. |
| Values | As the table above, except JSON writes every value as a string (NULL as `null`). |
| Parts (Copy) | Each part written turned; with headers each part has its own first line. |

Transposed rows are read by per-row page lookups (`RowAccess`), copying no rows; the writer yields at each 1 MiB chunk
and checks the token every 1,024 cells (`TransposedTextChecks.cs`).

- **`results.copy { resultId, parts, headers, eol: 'crlf' | 'lf', maxBytes: 1 … 67,108,864, viewId?, transposed?,
  headerColumn? }`** (stream). A part is 1 – 64 ascending, disjoint inclusive row ranges (last row 2⁵³ − 1 runs to the
  end) by 1 – 64 column ranges; up to 64 parts. Open-ended rows end at the rows available at start (`partial`: set still
  open). An upper-bound `EstimateBytes` (text spans, `2 × bytes + 2` per binary cell, 4 per NULL, separators, headers)
  over `maxBytes` answers `TOO_LARGE` ("The selection is too large to copy ({n} MB; the limit is {m} MB). Use Save Results
  As instead.") with no DATA. Otherwise DATA bodies of at most 1 MiB under credit, checked for cancellation per page,
  then `{ rows, bytes, truncatedCells, partial, capped }` (`capped` 0 unless transposed). `headerColumn` (0 to 4,095, a shown column) only with
  `transposed: true` (`INVALID_PARAMS`).
- **`results.export { resultId, path, format: 'csv' | 'tsv' | 'json', headers, nullText: 'empty' | 'NULL', temporaryId,
  viewId?, transposed?, headerColumn? }`** (unary; answer includes `capped`). The path must be fully qualified, without
  NUL or a `\\.\` / `\\?\` prefix, and `temporaryId` 32 hex digits from main (`INVALID_PARAMS`); the set must be complete
  (`RESULT_OPEN`). It writes `{folder}/.varia-{temporaryId}.tmp` (`CreateNew`, `FileShare.None`, 1 MiB chunks), checking
  cancellation per page, flushes,
  and renames it over the target (a symlink is replaced, not followed), never touching the target before. A replaced file
  keeps its permissions (Unix: created with the target's mode, never wider, and set to it exactly; a file replacing a
  symlink to a file gets the linked file's read and write bits, narrowed by the umask. Windows: `File.Replace` keeps attributes and, where
  the user may set them, ACLs (merge errors ignored, so a share granted Change rather than Full Control still saves), with
  `.varia-{temporaryId}.bak` until success, so the old or new file always exists). Failure or cancel deletes the
  temporary file; if the backend stops first the export fails `BACKEND_LOST` and main removes the temporary file at once
  and again after the stop grace period, and the backup only once the target exists. Failures are `EXPORT_FAILED` with a
  one-token message, never a path or an OS message: `ACCESS` (0x80070005), `IN_USE`
  (0x80070020, 0x80070021, 0x80070497), `DISK_FULL` (0x80070070, 0x80070027, errno 28), `NOT_FOUND`, `IS_DIRECTORY`,
  else `IO`.
- **Progress.** Droppable `{ type: 'job.progress', rowsDone, rowsTotal, bytes }` EVENTs at most every 250 ms (transposed:
  source columns). Main validates them (`jobProgressSchema`) and pushes `varia:results-job { jobId, kind, rowsDone,
  rowsTotal, bytes }` at most 4 a second, a save's with `fileName` (never the path), the first as the dialog closes.
- **Main (`ResultsJobHost`).** `varia:results-copy { jobId, generation, resultId, headers, parts, viewId?, transposed?,
  headerColumn? }` and `varia:results-save { jobId, generation, resultId, format?, suggestedName ≤ 128, suggestedSuffix?, viewId?,
  transposed?, headerColumn? }` are `trusted()`, strictly validated, and checked against
  `ResultsPortHost.owns(generation, resultId)` and the ready generation (`RESULT_UNAVAILABLE`). A copy decodes with a
  streaming `TextDecoder`, regrants credit, cancels with `TOO_LARGE` past 64 MiB + 1 MiB, and writes the clipboard once on
  the RESPONSE unless cancelled (then `CANCELLED`); a new copy cancels the running one. One save at a time (`JOB_BUSY`):
  the native "Save Grid Results" dialog gets a sanitised name (`src/main/file-names.ts`, keeping `suggestedSuffix` such
  as `-Result2-Pivot` whole), the format follows the chosen extension (an unknown extension keeps the requested format and nothing is appended,
  so the dialog's overwrite confirmation stays valid), ownership is checked again, and only the file name
  returns (`EXPORT_FAILED` tokens become sentences naming only it). `varia:results-job-cancel` sends CANCEL reason 1; a
  reload or closed window, reason 3. Dialogs are shown one at a time (`src/main/dialog-queue.ts`). Paths come only from
  the dialog and never reach the renderer.
- **Local saves (`ResultsJobHost.saveLocal`).** `varia:results-save-local { suggestedName ≤ 128, columns, rows }` saves a
  table the renderer holds (a local grid's): `trusted()`, strictly validated (1 – 64 columns, names ≤ 128, ≤ 10,000
  rectangular rows, cells NULL or ≤ 4,000 characters, ≤ 4 Mi characters in all), refused `TOO_LARGE` when its file in the
  format chosen could pass 64 MiB (`localSaveBytes`, an upper bound per format; before the dialog when no format fits,
  and always before the file is built), and sharing `JOB_BUSY` with results saves. Main formats it with
  the TypeScript writer a page at a time, yielding between pages, and writes a temporary file renamed over the target
  (`writeLocalSave`): a deleted folder is never recreated (`NOT_FOUND`), and a replaced file keeps its Unix permission
  bits; on Windows it keeps no attributes or ACLs (Node has no `File.Replace`). Failures use the results save's tokens;
  a Windows rename refused over a held file is `IN_USE`, over a read-only one `ACCESS`, over a folder `IS_DIRECTORY`.

## Live subscriptions

Periodic data flows through one stream method, `live.subscribe`, and one control method, `live.update`; the backend
schedules every sample and the renderer never polls. A subscription names one **source** and 1 to 8 of its **probes**,
each with its own interval; a probe emits metrics (series values), up to 4 snapshot tables (replaced by each sample), up to
4 append tables (that grow) and status values. `src/shared/live/catalog.ts` declares every source and probe; it generates
[docs/live.md](live.md), the backend's embedded `Live/live-catalog.json` (`npx vitest run tests/live-catalog.test.ts -u`)
and the schemas in `src/shared/live/schema.ts`. Production sources: `activity` (Activity Monitor: `activity.overview`,
`.sessions`, `.resources`, `.queries`), `explorer` (Object Explorer status chips) and the scope-`ssisdb` sources
`ssis.catalog` (its `ssis.catalogProbe` fingerprints the catalog) and `ssis.operations`, plus `query.plan` (scope
`server`, the live execution plan, through `Plans.LivePlanSampler` rather than a `SqlSampler`). The test source `debug.synthetic`
is accepted only by main's test schemas (`ResultsPortHost` with `testSources`, unpackaged smoke runs) and a backend with
`VARIA_BACKEND_TEST_HOOKS=1`. Both methods are port methods (`PortMethods`), reachable only through the results port; a
backend whose HELLO lacks either is refused.

**Request** (strict at every level; the backend checks the same rules against the same catalogue):

```ts
live.subscribe { subscriptionId: uuid, connectionId: uuid, source, probes: { probe, intervalMs: 1,000..3,600,000, paused?,
                 sort?: { column, descending, table? }[1..4], view?, filter?: { text: 1..400, columns?: id[1..8] } }[1..8],
                 args?, resume?: base64url ≤ 256 }
live.update    { subscriptionId, source, paused?, probes?: (the same, intervalMs optional, clear?: (sort | view | filter)[1..3])[1..8],
                 refresh?: true, track?: { probe, table, seq: u31, keys: str ≤ 512 [≤ 64], linger?: 0..keys }[1..8], args? }
```

- Each probe belongs to the source and is named once; its interval is clamped to the probe's minimum and maximum.
- Sort names catalogue column ids of the probe's snapshot tables (the row key breaks ties). A key with `table` sorts only
  that table and must name one of its columns; without it, every snapshot table with the column. Each column once per table.
- A view must be one the probe declares; a filter needs a probe with a filter mode.
- `args` is checked by the source's schema (`liveArgsSchemas`):
  - `debug.synthetic`: `{ rows?: 0..10,000, tickMs?: 10..60,000, endAfterTicks?: 1..10,000, errorEvery?: 1..1,000,
    logRows?: 0..10,000, logLevel?: 0..3, lateEvery?: 1..1,000, start? }` (a period below the 1 s minimum for fast tests).
  - `activity`: `{ filters?: activity filter[1..7], focusSession?: 0..32,767 }` (`activityLiveArgsSchema`, at least one
    member). One filter per table (`activityFilterSchema`: view chip, System and Varia chips, filter box ≤ 400 characters,
    ≤ 8 column value filters of ≤ 50 values ≤ 256 characters on facet columns, Hide benign waits). An update replaces the
    filters of the tables it names and keeps the others (an absent member keeps its value); a table without one uses the
    catalogue defaults. `focusSession` is the session the
    sessions probe's two series follow (0 for none); the first sample after it changes is marked `gap: 'reset'`. Column ids
    are unique within a probe (the first table keeps catalogue ids, others take a prefix: `chainSessionId`, `activeCpuMs`).
  - `ssis.operations`: `{ kinds?: ('execution' | 'validation' | 'deploy' | 'other')[1..4], statuses?: (1..9)[1..9],
    folder?: str 1..128, project?: str 1..128, package?: str 1..260, prefix?: boolean, caller?: str 1..128,
    windowHours?: 1..8,760, limit?: 1..10,000 }` (kinds and statuses distinct; `Live/SsisOperations.cs` checks again); new
    args replace the old whole (an absent member does not filter) and read the window again.
  - `query.plan`: `{ queryId: uuid }`, required by the backend: the running query whose live plan is sampled; an update cannot
    change it (`INVALID_PARAMS`).
- `start` (`liveStartSchema`, sources whose append tables can start mid-way): `'beginning'`, `{ tail: 1..200,000 }` or
  `{ before: 1..2^53−1 }` (the rows before an id, ending there).
- `track` names a keyed snapshot table by index; each key is the key cells' stored texts joined with U+001F; `linger` is how
  many of the first keys stay one revision after they leave (all when absent).
- `resume` is refused by a source without append tables; a token is base64url only (a trailing newline is refused).
- An update must change something and repeats the source (main and the backend check it). An absent setting keeps its value;
  `clear` drops the sort (back to the source's order), view or filter, each once and never beside a new value for it. A subscribe refuses `clear`.

**Frames.** The first EVENT is `live.opened` (seq 0): `{ source, band?, spid?, isolation?, probes: { probe, intervalMs,
minIntervalMs, maxIntervalMs, state: ok | limited | unavailable, reason?, note? ≤ 400 }[] }`. Then one `live.tick` per
scheduler wake that sampled something (seq 1, 2, …):

```ts
{ sampledAt: Unix ms (monotonic), spid?, resume?, errors?: probe error[1..8],
  samples: { probe, costMs, effectiveIntervalMs, elapsedMs? (absent for the first), gap?: baseline | reset | resumed | late,
    skipped?, metrics?: (number | null)[], status?: { id, value: integer | str ≤ 128 }[≤ 16], resorted?: true,
    tables?: { table, descriptor, revision, retired?: u32[≤ 2], diff?: { added, removed, changed },
      tracked?: { seq, rows: (row | −1)[≤ 64] }, departed?: row[1..64],
      facets?: { column, values: { text ≤ 128, count }[≤ 100], more?: true }[1..7] }[≤ 4],
    append?: { table, descriptor, segment, rolledFrom?, retired?: u32[1..8], restarted?: true }[≤ 4] }[≤ 8] }
```

A probe error is a value, so other probes carry on: `{ probe, code, message ≤ 2,000 (a sentence, never SQL, names or
values), number?, retryInMs, terminal, tables?, series? }`. `tables`/`series` name what one failed statement would have
filled; a probe may report several errors in a tick; `terminal` is true only when the probe stopped, never beside a sample.
`code` is one of `BLOCKED`, `TIMEOUT`, `PERMISSION_DENIED`, `NOT_SUPPORTED`, `DATABASE_UNAVAILABLE`, `CONNECTION_LOST`,
`SQL_ERROR`, `AUTH_KERBEROS`, `AUTH_ENTRA`, `AUTH_IDENTITY`, `BUDGET`, `BUSY`, `CATALOG_MISSING`, `NOT_FOUND`,
`LOGIN_FAILED` or `AGENT_DISABLED` (SQL Server Agent stopped or `Agent XPs` 0, error 15281; terminal, restarted by a refresh).

A `resorted` sample is not a sample: after an update changes a probe's sort, the next tick re-sends its snapshot tables in the
new order (see Re-sort) with `costMs` 0 and nothing else; the renderer keeps the last sample's time, cost and error. A probe
due in that tick is sampled instead.

Main checks every frame against `liveEventSchema` (each probe once, metrics aligned with the catalogue's series, tables by
catalogue index with the catalogue's column names in order, ≤ 8 tables a tick, departed rows and facets only where declared,
≤ 32 KiB facet text (UTF-8) a tick, declared status ids, error tables and series the probe has, `seq` 0 then +1) and against its subscription (`liveEventFits`:
`live.opened` names the subscription's source and reports each subscribed probe once, and a tick samples or fails only
subscribed probes), and stamps the generation on every descriptor. The worst-case tick
encodes to at most 192 KiB (`tests/live-schema.test.ts`); a tick over 256 KiB is never sent: the subscription ends `failed`
with `BACKEND_ERROR`.

**Tables** (`Live/LiveTables.cs`; per-table settings in docs/live.md). Every table is a stored result read with
`results.read`: cells are CellFormat text, every column `text` on the wire, so Copy and Save treat it as any result.
- **Snapshot tables.** Each sample writes a new result (a revision). The newest and the one before stay readable; writing
  k+1 releases k−1 and names it in `retired` (one that could not be stored names it in the next that is). A revision applies the probe's view, then its filter (`filterMode: 'memory'`:
  case-insensitive contains over the named columns of that table, or all; columns of another of the probe's tables leave
  this one whole), sorts by the probe's keys (numbers as numbers,
  NULL first ascending, text case-insensitively then exactly), then by the key (a table that no key names keeps the source's order), and stores at most the row cap (`rowLimit`,
  rows left out counted in `rowsRead`). `diff` counts keys added, removed and changed (a 64-bit hash of their texts);
  `tracked` gives each key of the latest track list its new row or −1. A key is its key cells' texts joined with U+001F, NULL
  as empty. A table with `departed` keeps a tracked row that left the source (not one hidden by view or filter) for one more
  revision at its old row; only the first `linger` keys stay. Facet columns carry their distinct values over the rows the
  facet scope keeps (before view and filter; the Activity Monitor's Sessions counts only rows its chips show), most frequent
  first, at most 100 of at most 128 characters, sent only when changed; facet text overflowing the tick's 32 KiB is left
  out (`more`) for a later tick.
- **Re-sort.** A snapshot table holds its newest revision's pre-sort rows while the subscription's held rows stay within a
  quarter of its memory limit (16 MiB). When an update sets or clears a sort, the next tick (once the previous is
  acknowledged, paused or not) writes each table whose order changes as a new revision from those rows, with the same retire rule, its own
  budget (`BUDGET` if it does not fit), `diff`, `tracked`, `departed`, no facets, marked `resorted`. No statement runs; a
  table with nothing held waits for its next sample.
- **Row tones.** A table may end with a tone column (catalogue `role: 'tone'`, nvarchar, never a key, facet, sort or filter
  column): `error`, `warning`, `running`, `muted` or NULL. `ResultColumn.role` `tone` keeps it hidden in the grid, and Copy
  and Save Results As leave it out (`ResultTextWriter.Hidden`).
- **Append tables.** One result (a segment) grows by the rows read above the table's settled id, keyed by one integer id.
  Ids are assigned at insert, not commit, so each read re-covers unsettled ids (`@top` = rows per tick plus unsettled ids
  above `@after` = settled id) and skips rows already appended, so a late row is appended once, in arrival order. An id settles once seen for the table's settle ticks and
  milliseconds (2 and 5 s by default); unsettled ids stay within twice the rows a tick reads. Each write seals its rows; a
  sample carries the table only when it changed. At 200,000 rows or 32 MiB a segment completes and a new one starts
  (`rolledFrom`); on a roll the oldest completed segments are retired while the completed ones hold more than one segment's worth and two
  or more are left (a segment stopped early for memory counts only what it holds); at most 8 stored results per table,
  past which the oldest goes whatever it holds. A read opens at most one new segment. Filter mode `restart` passes the filter to SQL Server as an escaped LIKE pattern (`@filter`,
  `ESCAPE N'\'`); a new filter or args that change what is read retire every segment (`retired` up to 8) and the next sample
  says `restarted` (old segments stay readable until the new first read arrives, and are released only together with the
  new segment's open, their bytes paying for its metadata when the budget refuses it). A tail or before-id start begins with a
  note row ("n earlier rows are not shown."); before-id also ends there (`@before`). Rows not stored (budget, or past a second
  segment) never count as seen, so a later read stores them once.
- **Memory.** Each revision and segment has its own budget; a subscription's tables share 64 MiB, and all live tables stay
  within a quarter of the result budget (`queryBudget` past the subscription's limit, `globalBudget` past the live share).
  A table that ran out stores what fits and its probe reports `BUDGET` (alone if it stored nothing); it stores again once
  memory frees, keeping what it holds: an append table whose segment ran out keeps it (complete) and opens the next only
  once a row fits, never retiring a segment to make room. Live results seal 64 KiB pages (under the large object heap's
  threshold), and their releases do not count toward the store's forced gen2 collection after every 64 MiB released.
- **Ends.** A source that ends keeps, complete and readable, each snapshot table's newest revision and each append
  table's newest segment first, then older segments while there is room, up to 64 kept results; the rest are released.
  Every other end releases them all.

**Credit: stop and wait.** The one place EVENTs are credited (`creditedEvents` in `methodPolicies`).
- The REQUEST carries `credit: 65,536`.
- **Producer rule** (`RequestContext.TrySendCreditedEvent`): the backend queues a live EVENT (control lane, never droppable)
  only when its available credit is back to the initial credit, then subtracts the body length (overdrawing by at most that
  frame). The source samples nothing while a frame is outstanding (`WaitForAckAsync`), so a slow or hung renderer stops SQL
  work after one tick.
- **Main's rule** (`BackendConnection.route`): an EVENT is accepted only when granted − received ≥ the initial credit and its
  body ≤ 256 KiB. Anything else, or any DATA frame on the request, is `STREAM_PROTOCOL` (CANCEL reason 3).
- **Acknowledgement.** Main posts `{ t: 'live', rid, bytes, event }` to the worker, which relays it undecoded; the page applies
  it and calls `ack(bytes)`, and only then does the worker send `{ t: 'credit', rid, bytes }`. The worker, `ResultsPortHost`
  and `BackendConnection.credit` all clamp an acknowledgement to the bytes outstanding, so two frames are never in flight.
- **Schedule.** Fixed rate per probe: a probe due while a frame is unacknowledged, or late for any reason, is sampled once
  with `gap: 'late'` and the missed slots in `skipped`, never replayed. The first sample is `baseline`, the first after a
  pause `resumed`.

**End** (the RESPONSE): `{ ended: cancelled | disconnected | sourceEnded | failed | shutdown, code?, message? (failed only),
kept?: u32[≤ 64] (sourceEnded only), resume?, ticks, elapsedMs }`. CANCEL reason 1 or 3 ends it `cancelled`, reason 4 or
backend shutdown `shutdown`, `connections.disconnect` of its connection `disconnected`. When every probe has stopped for
good (each terminal, or opened unavailable) it ends `failed` with the first probe's code (a live code such as `PERMISSION_DENIED` is accepted by `liveEndSchema`)
and message. Every end but `sourceEnded` releases the results first; `kept` stays readable until `results.close`.

**Update answer:** `{ applied: true, probes: { probe, intervalMs, effectiveIntervalMs, paused }[] }` for every probe,
applied at once; the next wake uses them. An unknown subscription is `NOT_FOUND`, one that is ending `CANCELLED`.

**Ownership.** `ResultsPortHost` owns each table a tick carries, takes back on `retired` only the stream's own results, and
at the end takes back all but `kept`. Closing the port cancels live streams (reason 3) and takes back their results; a
`sourceEnded` answer already on its way then has no reader, so main closes its `kept` with `results.close`.

**Backend** (`Live/LiveService.cs`): a registry by subscription id, at most 32 in the backend and 8 per SQL Server (`BUSY`:
"Too many live views are open for this server. Close one and retry."); a duplicate id is `DUPLICATE_REQUEST`. The server is
`SERVERPROPERTY('ServerName')` probed at connect (else the data source), so connections with other logins share its 8; a
source reaching no server counts by connection id. Refusals come before the sampler is built, and a sampler acquires nothing
until it runs. Each subscription is one task with its own schedule running due probes through an `ILiveSampler`.
`debug.synthetic` (`SyntheticSampler.cs`) runs no SQL and uses the same table writers; its probes cover metrics (a wave),
a moving snapshot table, status, a two-table grid (view, facets, departed rows, tones; `errorEvery` fails one table), an
append log (late messages, start, restart) and the 23-column table the churn benchmark swaps. Its scope is `none`, so any
connection id is accepted; other scopes need a connected one (`NOT_CONNECTED`). Nothing is logged.

**Scheduler** (`LiveSubscription`; driven on a fake clock by the offline checks):
- **Phase.** A subscription starts and resumes at a random point within a quarter of its first second, one phase for all
  its probes, so views opened together never wake together while one view's probes share ticks.
- **Quick second sample.** After a `baseline` or `resumed` sample the next is due within a second (rates need two). A
  `baseline` sample never carries `skipped`.
- **Refresh** makes every unpaused probe due now, but never within its catalogue `minGapMs` or minimum interval of its last
  attempt. A backing-off probe keeps its delay and failure count; one a terminal error stopped restarts with a clean count (not one the source opened unavailable).
- **Error back-off.** The first failure retries at the interval; after f failures in a row the next try is
  min(interval × 2^(f−1), cap) × U(0.9, 1.1), cap 60 s or the asked interval if longer. A sample resets the count. `BUDGET`
  retries at the interval; a terminal error (`LiveErrors.IsTerminal`: `PERMISSION_DENIED`, `NOT_SUPPORTED`,
  `LOGIN_FAILED`, `CATALOG_MISSING`, `NOT_FOUND`, `AUTH_IDENTITY`) stops its probe (`retryInMs` 0).
- **Load guard.** An EWMA (α 0.3) of `costMs` over the catalogue `maxDutyCycle` (0.25, 0.2 for `activity.*`) of the interval
  in force for 3 samples in a row doubles that interval up to the cap; under 10 % for 10 samples halves it back toward
  the asked one. Samples and the update answer
  report it as `effectiveIntervalMs`. A new interval from `live.update` restarts the guard.
- **Idle.** While every probe is paused, the next sample is ≥ 30 s away, or all intervals in force are ≥ 30 s (never before a quick second sample), the source returns its
  connection to the pool and reopens when a probe is due. All probes starting paused open no connection.

**SQL sources** (`Live/SqlSampler.cs`; scope `server`: `activity`, `explorer`; scope `ssisdb`: `ssis.catalog`, `ssis.operations`).
- **Connection.** One pooled connection per subscription from the scope's pool: the connection's **" - Activity Monitor"**
  pool for server DMVs, its **" - Integration Services"** pool (Initial Catalog the catalog's database, `SSISDB`) for SSISDB
  (`LiveConnections`; cleared on disconnect). Held while sampling, so its `spid` is known (a tick carries `spid` when it
  reopened). Connecting takes no live gate and has its own 15 s bound (`TIMEOUT` past it); a connect that failed in a
  tick is reported for that tick's other due probes rather than tried again at once.
- **Prologue** on every command: `SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 1000;
  SET DEADLOCK_PRIORITY LOW;` (`READ COMMITTED` instead for an SSISDB with READ_COMMITTED_SNAPSHOT).
- **Session probe** (2 s budget, under a gate): `@@SPID` and `HAS_PERMS_BY_NAME` for VIEW SERVER PERFORMANCE STATE (SQL
  Server 2022+) or VIEW SERVER STATE (earlier, Managed Instance), the name a parameter. An SSISDB source also reads
  `is_read_committed_snapshot_on` (picks the prologue and `live.opened`'s `isolation`) and whether the login is sysadmin or
  ssis_admin (`IS_SRVROLEMEMBER` first): only they read `catalog.catalog_properties`, through one of two parameterless
  constant texts. An SSISDB open failing with 4060 or 916 reads why in the login's own database: no row is
  `CATALOG_MISSING` (terminal; `PERMISSION_DENIED` for a login without VIEW ANY DATABASE), not online, single-user or
  restricted `DATABASE_UNAVAILABLE` (retried), online but not openable `PERMISSION_DENIED` (terminal). The Activity Monitor
  runs `Activity/ActivitySql.cs` `Capabilities` instead (server state, ALTER ANY CONNECTION, VIEW ANY DEFINITION, spills),
  sending `serverState` and `canKill` as status values with every sessions sample.
- **Gating.** A probe whose catalogue gates (band, Managed Instance as newest; EngineEdition) exclude the server opens
  `unavailable` `NOT_SUPPORTED`; one needing server state the login lacks opens `unavailable` `PERMISSION_DENIED`; neither
  runs. When the session probe did not run at open, such a probe opens `ok` and stops at its first tick with a terminal
  `PERMISSION_DENIED`, running nothing; so does one whose new connection's session probe finds the permission gone.
- **Budget.** Each statement waits for a live gate (at most its budget, else `BUSY`) and runs with `CommandTimeout` 0 under a
  token firing at 0.8 × the asked interval within the probe's `budgetMs` (500 ms to 5 s by default, never above 10 s; the catalog
  probe 500 ms to 10 s).
- **Multi-statement sources** (`ILiveSqlReader`, `ActivityReader`) run statements one at a time within that budget and
  build rows in C#; each read is checked against its declared columns (`BACKEND_ERROR` on mismatch). A statement the login
  may not run (`PERMISSION_DENIED`) or the server lacks (`NOT_SUPPORTED`) fails alone and is not rerun on that connection;
  another statement error stops the remaining statements, what was read arrives. Without server state the sessions probe
  reads only the caller's session and reports Blocking and Active Expensive Queries as `PERMISSION_DENIED` without SQL.
- **One-batch probes** (`Live/LiveSql.cs`, constant text per probe and band: Object Explorer's status probes and the SSIS
  tree's catalog probe): a metrics row with the declared columns (whole
  numbers; a status-only probe sends no metrics or baseline gap), then one result set per table in catalogue order with the
  table's column names and types (integers, text, bit, float, real, decimal, date/time types, uniqueidentifier; anything
  else fails the open). An append read takes `@after{i}`, `@top{i}`, `@before{i}` and may name a tail statement returning
  `(after_id, earlier)` for `@tail{i}`. Snapshot result sets read up to 10,000 rows. A failed later statement still delivers
  earlier tables. Values only as parameters; the offline lint, rendering every probe at every band, refuses metadata
  built-ins, temporary tables, `SELECT … INTO`, writes, DDL, transactions, `WAITFOR`, `EXEC`, `sp_executesql`, `OPENQUERY`,
  `OPENROWSET`, `OPENDATASOURCE`, comments, and `TOP` without an `ORDER BY` at its own level. Columns are read by declared
  position after a check (mismatch: `failed` with `BACKEND_ERROR`); the live checks compare every query's columns.

**Readers.** An `ILiveSqlReader` (`Live/LiveSqlReader.cs`) keeps everything else of a SQL source (connection, gates, one
budget, deltas, writers, back-off, error mapping), replaces the session probe and may choose its prologue. A connection- or
budget-breaking error fails the probe; a single-statement error is a value naming its tables or series.
`ssis.operations` (`Live/SsisOperations.cs`) is one: `READ COMMITTED` or `READ UNCOMMITTED` by the catalog's RCSI setting,
no server permission (row-level security). Its probe `ssis.operations.list` keeps the window in backend state:
- A baseline (first sample, new args, lost connection) reads the newest `2 × limit` operations of the scope that are open or
  created in the window and pass the status filter (open hidden ones followed unseen), plus the newest `2 × limit` open ones
  of any age.
- Later samples read operations above the newest settled id (settle: 2 samples and 5 s) and re-read held open ones by id (an
  `xml` list `@open`, ≤ 256 a sample, in turn); a row no longer found leaves. It keeps `limit` rows, open first, then newest.
- Scope matches an execution's folder, project and package, a validation's folder and project, a deployment's project.
- Tiles ignore scope, status filter and limit: running and pending counts (`status IN (2, 5)`) every sample, the last 24 hours
  by final status every 30 s and with each baseline.
- Lists go in as `xml` read with `.nodes('/i')`, names as escaped `LIKE` patterns (a trailing `%` for a prefix), times
  stay `datetimeoffset`; the SQL passes the live and SSIS lints. A
  server on Linux or older than SQL Server 2016 opens the probe `unavailable` `NOT_SUPPORTED`.

**Errors** (`Live/LiveErrors.cs`); messages are sentences naming no object or value:

| SQL Server | Code |
| --- | --- |
| 1222, 1205 | `BLOCKED` |
| the statement budget | `TIMEOUT` |
| 297, 300, 229, 262 | `PERMISSION_DENIED` (terminal; an SSISDB source has its own sentence) |
| 207, 208 | `NOT_SUPPORTED` (terminal) |
| 4060, 911, 942, 952 and other offline, restoring and single-user numbers | `DATABASE_UNAVAILABLE` |
| severity ≥ 20, transport errors | `CONNECTION_LOST` |
| Kerberos or Entra failure while reconnecting | `AUTH_KERBEROS`, `AUTH_ENTRA` (retried with back-off) |
| a changed or unprovable account identity while reconnecting | `AUTH_IDENTITY` (terminal) |
| 18456, 18486, 18487, 18488, 18452 while reconnecting | `LOGIN_FAILED` (terminal: retries could lock the login out) |
| anything else | `SQL_ERROR` with SQL Server's text |

An SSIS source's `CATALOG_MISSING` and `NOT_FOUND` are terminal too. A statement cancelled at its budget or by an ending view
leaves a connection that is kept only if it passes `LiveConnections.AnswersAsync` (open, `SELECT @@TRANCOUNT` answers 0
within 1 s); otherwise it is dropped and its pool cleared, and the next due tick reopens under back-off. Only
`NOT_CONNECTED` ends the view `disconnected`. Nothing is logged.

**Deltas** (`Live/LiveDeltas.cs`): the backend keeps baselines only; history is the renderer's. Counter kinds: `gauge`,
`rate` and `msPerSecond` (per second), `ratio` (change over a base counter's change; none if the base did not move) and
`cpuPercent` (100 × Δ CPU ms / (elapsed × schedulers), 0 to 100). Elapsed time is the server's (Δ`ms_ticks` of
`sys.dm_os_sys_info`) when the probe reads it, else the backend's; `elapsedMs` reports it. A changed start time (a restart) drops every
baseline (`gap: 'reset'`); a reader whose series follow something else from a sample on (`SeriesReset`: the Activity
Monitor's focus session) marks that sample `reset` without dropping other baselines; a counter that went down rebaselines
alone (null, `reset`); the first sample, the first after a pause and after a lost connection have no rates (`baseline`,
`resumed`); a sample over 3 intervals after the previous one is `late`. Reopening a connection that went back to the pool
while idle keeps the baselines. `LiveKeyedDeltas` keeps per-row baselines keyed by an identity column, bounded by the row
cap, dropped after two absent samples, each with the time it was read on the probe's sample clock (a returning row's rate
spans its own gap). The Activity Monitor's per-session CPU and reads
use `SessionRates` (`Activity/ActivityRows.cs`): each running request counts by its own change, ended ones only beyond what
they counted.

**Resume tokens** (`Live/LiveResume.cs`): base64url of `{"v":1,"source":…,"cursors":[[probe,table,settledId],…]}`, at most 256
characters (else no token), parsed strictly against the source and its append tables (`INVALID_PARAMS` otherwise). A tick
carries `resume` only when a cursor moved, the end carries the last; a resumed subscription starts each append table after
its cursor. A source without append tables (the Activity Monitor) refuses `resume`.

**Renderer.** The results worker relays live requests and events and `ResultClient.live` runs the stream ([Results port and
results worker](#results-port-and-results-worker)). Views open a `LiveHandle` from `LiveService`
(`src/renderer/src/live/LiveService.ts`, `workbench.live`), which owns the lifecycle; docs/live.md covers the user-facing
behaviour.
- **Open.** `live.open(spec, owner)` subscribes with catalogue default intervals unless asked otherwise. `documentOwner(tabId)`
  is visible while its tab is shown in its editor group (the active document without groups) and the editor area
  shows, follows the tab's connection and closes with it. The SSIS tree's views
  (`SsisTreeProbe`) belong to Object Explorer and hold ordinary slots. At most 16 views hold a slot per window (main's 16
  port streams). A `background` view (`LiveSpec.background`: Object Explorer status via `ExplorerStatusService`) takes only a
  free slot, at most 8: without one it waits (`dormant`, `waiting: true`, running nothing). A view opening when all 16 are
  taken takes the newest running background view's slot, which stops and waits again; the new view subscribes once that
  stream's end has arrived, so main never sees a 17th. A closing view hands its slot to the oldest waiting background view,
  which subscribes after the closed stream ended (or stays dormant while hidden). With every slot held by other views, or
  unknown probes, the handle ends at once with `TOO_MANY_REQUESTS` or `INVALID_PARAMS` as a value. A view the backend
  refuses with `BUSY` before it opens takes the newest running background view's slot on the same server (`serverOf`: the
  server the connection names, else the same connection) and subscribes once more after that stream ended (a second
  refusal, or no such view, ends it `BUSY`); a refused background view waits and retries when a view of the window closes.
- **Frames.** Each event is applied synchronously (states, history ring, tables as `ResultHandle`s), then `onTick` listeners
  run, then it is acknowledged. Snapshot listeners hear at most once an animation frame.
- **Hidden.** Hidden (owner or `document.visibilityState`) for `liveData.pauseAfterSeconds` (2 s) sends
  `live.update { paused: true }`, shown again `paused: false` at once; a view opened or reconnected while hidden counts from then, and a changed delay
  applies to views already hidden, counted from when they hid. Hidden for `liveData.stopAfterHiddenMinutes` (5 min) cancels
  (`dormant`, the backend releasing what it held); shown again it subscribes with a new id and the last resume token, its
  history continuing after a gap. `liveData.pauseWhenHidden` off keeps hidden views running. A source allowing
  `hidden: 'statusOnly'` (none does yet; only the renderer acts on it) lets up to 4 views a window with `whileHidden` keep
  table-less probes at `limits.live.hiddenIntervalMs` (30 s) or slower instead of pausing, never going dormant, with
  their table probes paused; the rest pause, and a view that ends, is lost, closes or shows hands its slot to the oldest
  view that paused only for want of one.
- **Pause, settings, refresh.** The user's Pause is `paused: true`, never undone by visibility. Settings changed within
  150 ms go as one update (with `clear`). Updates wait for `live.opened` (an earlier one is refused `NOT_FOUND`) and go one
  at a time, in order, each from what the backend last accepted, so a resume never overtakes its pause. A refused update
  leaves the view showing what the backend still runs, with the reason in `error`; `TOO_MANY_REQUESTS`, `BUSY`, `TIMEOUT`
  and `BACKEND_UNAVAILABLE` refusals retry after 1 s doubling to 30 s, others with the view's next change, and the next
  accepted update clears the error. A view subscribing while paused pauses every probe in `live.subscribe` and unpauses them when it resumes; one opened
  with `paused: true` is user-paused from the start.
  `setArgs` changes `args` in place (history and state carry on); Refresh sends `refresh: true`. `LiveHandle.refresh`
  subscribes again a dormant view and, as Retry, one whose subscription failed or was refused while its owner still has
  the connection; one that was disconnected, cancelled or whose source ended stays ended; `track` sends tracked keys with a new `seq`, sent again with new ones by a new subscription.
- **Ends.** A lost backend (`BACKEND_LOST`, `RESULT_UNAVAILABLE`, `BACKEND_UNAVAILABLE`) leaves the view `lost` with its
  history; nothing resubscribes by itself. A retargeted owner resubscribes once the old stream's end arrives (main and the backend count a cancelled stream until
  then, so a full window or server keeps the view's slot; a dormant view stays dormant until it shows); a lost owner
  connection ends it `disconnected`; other ends are `ended`. Closing the view releases every kept result.
- **History.** `MetricRing` (`live/ring.ts`) keeps samples in typed arrays (time, gap and reset flags, one value per series,
  NaN missing): `liveData.historyMinutes` at the probe's interval, at most 7,200 samples, fitted to 4 MiB a view and 32 MiB in
  all. Renderer memory only, so it survives a backend restart.
- **Charts.** `ChartView` (`live/ChartView.ts`, imperative like `GridView`) draws one probe's ring on a canvas; `LiveChart`
  (`live/LiveChart.tsx`) adds the legend and "View as table". It draws at most once an animation frame, only when something
  it shows changed and the canvas is on screen and the page visible; each series is reduced to min and max per device pixel
  column (stacked bands to each column's mean), so a draw is O(samples in window); a gap flag or a missing value breaks a
  line, and a series index the ring lacks reads as no value. Colours come only from the theme's `charts.*` keys and the surface the chart sits on (`chartSurfaces`; forced colours: `CanvasText`,
  `Canvas`, `GrayText`); at most 12 series (`chartLimits.series`). The canvas is `role="img"` with a name updated at most
  every 5 s, keyboard crosshair keys and a polite status region; text is Text nodes, never markup. Times read "now" only
  while the probe is `fresh` or `limited` and its newest sample is within twice its effective interval. `scaledRing(ring,
  factor)` shows a series in another unit.
- **State.** Status `connecting`, `live`, `paused` (`hidden` or `user`), `dormant`, `lost`, `ended`; probe state `fresh`,
  `stale` (nothing for twice the effective interval; the one timer a view keeps), `failing`, `limited`, `unavailable`,
  `paused`. `liveIndicator`, `pillStatus` and `freshness` (`live/status.ts`) derive the pill and badge text;
  `live.peek(source)` reads open views without subscribing.
- **Tables.** `handle.table(probe, index)` is the latest result as a `ResultHandle` with revision, diff and departed rows, or
  segment, `rolledFrom` and `restarted`. The view keeps every track list sent since the newest one answered (≤ 64).
- **Activity Monitor.** One handle on `activity` with every probe, owned by its tab; `ActivityMonitorService` pauses probes no
  shown pane whose grid exists reads (`paneProbes`; the overview always runs) and raises the interval to each probe's floor
  (`probeIntervalMs`).

**LiveGrid** (`live/LiveGrid.ts`, mounted by `live/LiveGridPane.tsx`): a live table in the shared grid (`grid/GridShell.tsx`
over `GridView`, as `ResultGrid` uses). A live source adds `GridView.swap(handle, descriptor, mapRow)` (another result with
the same columns in place; selection and scroll move through `mapRow`, `grid/swap.ts`), the hidden tone column, follow tail
and the "n new rows" button.
- **Shared components.** Header sort calls `LiveGrid.cycleSort` (`cycleSortKeys`, `grid/sort-keys.ts`), setting the probe's
  sort for this table; `sortable={false}` removes it. Funnels appear on the owner's source-filtered columns
  (`GridViewOptions.filterable`); `ColumnFilterPopover` runs over a `ColumnFilterSource` (`live/live-filter.ts`) built from
  the facets, and OK sends the filter as the source's args (ticked values, or unticked ones with `exclude`), never filtering
  on the client. The grid is Query Output's view `live` (`registerLiveOutput`), so the `output.*` commands and keys apply
  (Sort with `outputLiveSortable`, Filter with `outputLiveFilterable`). `GridErrorBoundary` wraps source and shell.
- **Snapshot revisions.** After each applied tick, before acknowledging, the grid prepares the new revision's rows
  (`GridView.prepare`, ≤ 250 ms) then swaps. It tracks the selected rows plus neighbours and the first row shown (≤ 64)
  with `track` (sent only when the list changes), `linger` counting the selected keys, and maps rows to where the backend says their keys went; an unanswered
  selected key stays pinned until a revision places it. A view at the very top stays at the top. Departed rows are muted for
  their one revision. A disposed grid sends an empty list.
- **Tones.** Each row takes `tone-error`, `tone-warning`, `tone-running` or `tone-muted` (theme keys
  `resultsGrid.row{Error,Warning,Running,Muted}{Background,Foreground}`); `toneLabel` names tones for screen readers.
- **Append segments.** At the last row the view follows; scrolled up it stays and counts new rows ("n new rows · Jump to
  latest"). A roll keeps following; a restart keeps the tail if it followed, else the top.
- **Remounts.** An owner keeps a `LiveGridState` (scroll, widths, selection, `following`, selected keys) across unmounts.
- **Sort, Copy, Save.** `sortBy(column, descending)` sets this table's key (never the tone; append tables keep arrival order).
  Copy uses `results.copy` on the shown revision, which it leases. Save of a live snapshot table saves the newest revision
  the renderer owns once the file is chosen (`ResultsPortHost.liveNewest`), failing `RESULT_UNAVAILABLE` only if the
  subscription ended without keeping it; an append segment saves once complete.
- **What the owner sees.** The snapshot carries the table shown, new-rows count, sort, `lost`, `released` (`dormant` or
  `stopped`), the selection and `activeKey`, published only when one changed.

## Results port and results worker

**Opening.** The renderer calls `window.varia.openResultsPort()` (`varia:results-port-open`, `trusted()`, at most 10 a
minute per page load). Main closes the previous port (CANCEL reason 3 for its streams), creates a `MessageChannelMain`,
posts `varia:results-port` with one port to the requesting main frame, and tells the worker the generation and status.
The preload re-posts the port to its window; `ResultClient` accepts it only from `window`, only while expecting one, and
only with exactly one port, then transfers it to the worker. The port closes on reload, renderer crash and window
close; a backend loss ends its streams but keeps the port.

**Worker → main** (`portRequestSchema`, strict; a parse failure answers `INVALID_REQUEST` when `rid` is readable; the
100th invalid message closes the port):

```ts
{ t: 'read'; rid: u31; generation; resultId: u32; firstRow: 0..2^53-1; maxRows: 1..65_536; credit: 65_536..16_777_216; viewId?: u32 }
{ t: 'credit'; rid; bytes: 1..16_777_216 }
{ t: 'cancel'; rid }
{ t: 'close'; rid; generation; resultIds: u32[1..1024] }
{ t: 'rowBytes'; rid; generation; resultId: u32; firstRow: 0..2^53-1; count: 1..16_384; viewId?: u32 }
{ t: 'view'; rid; generation; resultId: u32; sort: ViewSortKey[0..16]; filters?: ViewFilter[1..16]; replaces?: u32 }  // a sort key or a filter
{ t: 'viewClose'; rid; generation; resultId: u32; viewIds: u32[1..64] }
{ t: 'search'; rid; generation; resultId: u32; text: string[1..1024]; fromRow; maxMatches: 1..10000; backward?: boolean; viewId?: u32 }
{ t: 'identify'; rid; generation; resultId: u32; by: 'auto' | 'column' | 'row'; column? }  // column only with by: 'column'
{ t: 'rowIds'; rid; generation; resultId: u32; firstRow; count: 1..limits.identity.maxRows; viewId?: u32 }
{ t: 'findRows'; rid; generation; resultId: u32; ids: id[1..limits.identity.maxFind]; viewId?: u32 }
{ t: 'diff'; rid; generation; resultId: u32; right: u32; exact: boolean; context: -1..limits.diff.maxContext; match?; layout?: 'unified' | 'entry'; replaces?: u32 }  // main sends { left, right }
{ t: 'profile'; rid; generation; resultId: u32; columns: distinct column[≤ limits.profile.maxColumns]; viewId?: u32 }
{ t: 'pivot'; rid; generation; resultId: u32; rows: distinct column[≤ limits.pivot.maxRowFields]; column?; values: PivotValue[1..limits.pivot.maxValues]; viewId?: u32 }
{ t: 'distinct'; rid; generation; resultId: u32; column; viewId?: u32; keptViewId?: u32 }
{ t: 'distinctRead'; rid; generation; resultId: u32; snapshotId: u32; order: 'count' | 'value'; offset; count: 1..limits.distinct.maxWindow; search? }
{ t: 'distinctTick'; rid; generation; resultId: u32; snapshotId: u32; checked: boolean; groups? | all?: true | ranges? (with order) | invert?: true (search? with all or ranges; toggle? with ranges); nulls? }
{ t: 'distinctClose'; rid; generation; resultId: u32; snapshotIds: u32[1..limits.distinct.maxClose] }
{ t: 'live'; rid; generation; params: live.subscribe params }
{ t: 'liveUpdate'; rid; generation; params: live.update params }
```

Every request naming a result (all but credit, cancel, close, live and liveUpdate; diff checks both ids; a `close` of unowned
or earlier-generation ids answers `{ closed: 0, usedBytes: 0 }`) must name the current generation and a result the renderer owns (from a
query summary or event, at most 100,000 per generation), else `RESULT_UNAVAILABLE`; at most 64 requests may be
outstanding. A `live` request needs the current, ready generation (`RESULT_UNAVAILABLE`) and a subscription id not
already running on the port (`DUPLICATE_REQUEST`); at most 16 live streams per port (`TOO_MANY_REQUESTS`), counted
apart from the 64. A `liveUpdate` counts among the 64 and must name a live stream of the port and generation
(`NOT_FOUND`) with the same source (`INVALID_REQUEST`). `credit` grants a read stream more bytes or acknowledges a live event; `cancel` stops the read, operation or live stream
with that rid.

**Main → worker:** `backend { generation, status }` on every change, `page { rid, seq, body: ArrayBuffer }`,
`end { rid, ok, result | code, message }`, `query { queryId, event }`, `memory { feature: 'results' | 'index', usedBytes, globalBytes, detail?, generation, seq }`
(the sending backend's generation, possibly one being replaced), `progress { rid, phase, percent? }` (a view, profile,
distinct, pivot or diff request's `op.progress`, only while that request is in flight on this port; dropped once the
page gave the request up), and `live { rid, bytes, event }` (a validated live event and its EVENT body length, granted
back once the page applied it). Live streams and updates end with `end` (`result`: the live end or update answer).

**The worker** (`worker-core.ts`) keeps an LRU of decoded pages keyed by generation, result and first row (64 MiB or 512
pages; each page charged its bytes plus 320 bytes per column). Pages a pending window needs are never evicted; once
those alone pass 64 MiB, windows that already have rows answer early with them. It reads each missing contiguous range
once with 4 MiB of credit, waits for rows a read in flight will bring, cancels reads nobody waits for, and grants credit
after caching each page (a duplicate boundary page is credited without decoding). A page failing `decodePage` ends its
read with `PAGE_INVALID` and is not cached. A new generation fails pending work with `RESULT_UNAVAILABLE` and drops
older pages.

The worker also relays live subscriptions: the page sends `live { id, params }`, `liveUpdate { id, live, params }`,
`liveAck { id, bytes }`, `cancel { id }` and `forget { generation, resultIds }`; the worker answers
`live { id, bytes, event }`, `liveEnd { id, result }`, `liveUpdated { id, result }` or `error`. Streams go to the
generation main last announced; main takes a stream only for a ready generation (an `unresponsive` one still is), so
requests made before main's first `backend` message or while it is `starting` or `restarting` wait and go to the
generation that becomes ready (never more than one; a view restored at launch, or resubscribed as soon as the page
hears of a new generation, is not reported lost), and with no backend (generation 0) fail `BACKEND_UNAVAILABLE`,
waiting ones included. An update for an ended or cancelling stream fails
`NOT_FOUND`; a stream cancelled before it was sent ends `cancelled` with no ticks. Events are relayed undecoded; `liveAck` becomes
`credit` only within the bytes outstanding. A new generation ends older streams and updates with `RESULT_UNAVAILABLE` ("This live
view ended because the SQL backend restarted."), a replaced port with `PORT_CLOSED`; later answers for them are dropped. `forget` drops pages of
backend-released results and ends their reads with `RESULT_RELEASED`, without sending `close`.

**`ResultClient`** (`ResultClient.ts`) is the renderer's API: `open(descriptor)` returns a `ResultHandle` with
`getSnapshot`, `subscribe` (coalesced per animation frame), `getWindow(first, count, o)` (at most 4,096 rows, 262,144
cells and 4,000,000 characters; 1,024 characters per cell by default, at most 2,097,152; flags 1 NULL, 2 truncated,
4 read error, 8 over the text budget), `peekWindow`, `prefetch`, `getCell` (the whole stored value; `format: 'xml' |
'json'` pretty-prints it with `doc-format.ts` unless only a prefix is stored, and reports `formatted`) and `close`, plus
`onQueryEvent`, `onMemory`, `onGeneration` and `applySummary`. It forgets a result once released or its generation is
gone (handles report `released` or `lost`). The grid reads tiles of 128 rows × 32 columns, at most 512 characters per
displayed cell, through one shared window cache of 256 windows and 16,777,216 UTF-16 units (LRU, indexed by result). A
tile is re-read only from where its rows end: newly arrived rows (at most 10 reads a second), or the rest at once when
the worker answered short because the pages exceed its cache. `release(keys)` closes up to 1,024 results a request (a
run's sets at once on re-execute, tab close or Close Results, so the port's 64-request cap is not hit); ids wait while
the port is down, and `TOO_MANY_REQUESTS` refusals are re-sent after 250 ms. A failed worker is recreated and
reattached at most 3 times a minute; after that, results show "Results cannot be displayed; reload the workbench."

`live(params, onEvent)` returns a `LiveStream`: `done` (settles once with the `LiveEnd` or a failure value, never a
rejection), `update(patch)` (`live.update` with the stream's subscription id and source; failures are values, an ended
stream answers `NOT_FOUND`), `cancel()` (`done` settles `cancelled` at once for a stream never sent, even if the port
never attaches) and `ack(bytes)`. Before `onEvent(event, bytes)` runs, the event's tables are
applied (`applyLive`) and the results it retires (only this stream's) are forgotten; the caller applies the event
synchronously, then calls `ack(bytes)`, and nothing more arrives until then (an exception from `onEvent` is caught: the stream's
bookkeeping goes on and the event stays unacknowledged). A cancelled stream's events still count its results but no longer reach `onEvent`. On end its results
are forgotten, except those a finished source kept, readable until `release`. A
failed worker ends streams with `RESULT_DECODER_FAILED` (main cancels them when the new worker's port opens), `dispose` with `PORT_CLOSED`. `applyLive(descriptor)` creates
or updates a result as query events do, so an append table's handle notifies its listeners as it grows. `forget(keys)` marks
backend-released results released and drops their windows and pages, without `results.close`.

## Malformed input

| Side | Input | Handling |
| --- | --- | --- |
| main ← backend | Bad magic, kind or flags; wrong-direction kind; a second HELLO; stream truncated at EOF; an id at or above the next to be issued | **Fatal:** process killed, generation ends (`protocol`), counts toward the breaker |
| main ← backend | First stdout byte `{` | Protocol 1 backend: `failed (incompatible)` |
| main ← backend | Oversized body (skipped); undecodable RESPONSE or EVENT body; bad envelope; event failing `queryEventSchema` or `liveEventSchema`; live EVENT out of sequence, over 256 KiB or before the previous was acknowledged; DATA on a live stream; credit overrun; sequence gap; DATA for a non-stream; a frame for a settled id | **Contained:** that request or stream fails `STREAM_PROTOCOL` and gets CANCEL reason 3. The 8th contained violation in a generation is fatal. |
| main ← backend | Frame for an abandoned id | Dropped and counted |
| backend ← main | Bad magic, kind, flags or envelope | GOAWAY `PROTOCOL_ERROR`, exit 64 (main bug: fail fast) |
| backend ← main | Oversized REQUEST | Body skipped; RESPONSE `TOO_LARGE` with its id |
| backend ← main | Invalid params | `INVALID_PARAMS` |
| worker ← main | Page failing `decodePage` | That read ends `PAGE_INVALID`; the worker continues |
| worker ← page | Live acknowledgement over the outstanding bytes, not a positive integer, repeated, or for an ended stream | Dropped: no credit sent |
| backend | Unhandled exception, out of memory | Best-effort GOAWAY `BACKEND_CRASH` (exception type only), exit 70 |

Error details carry only a kind, an offset and a code: never bytes, SQL or server names.

## Backend threads and exit codes

- **Reader thread** (`varia-ipc-reader`) handles every frame inline: HELLO; REQUEST (validate envelope, register, start
  its task); CANCEL; CREDIT; PING, whose PONG it queues on the control lane itself so liveness survives a starved thread
  pool (SMO is synchronous). A CANCEL the host answers itself queues `CANCELLED` inline, but token callbacks run on the
  thread pool (SqlClient's attention is synchronous and must not delay a PONG). More than 288 requests in flight are
  answered `BUSY`. At stdin EOF it cancels everything, waits at most 1.5 s, disposes the service and exits 0.
- **Thread pool floor** (`ThreadPoolFloor`): minimum worker and completion threads are raised to 64 at start, because
  managed SNI (Linux, macOS) logs in synchronously on pool threads and timers (script deadlines) fire through the pool;
  without it a deadline could fire only after its batch finished. A live check holds 32 pool threads in sleeps and
  requires a 1 s deadline to stop a 5 s `WAITFOR` within 4 s.
- **Writer thread** (`varia-ipc-writer`) drains the control lane before the bulk lane, drops droppable events past 1,000
  frames or 8 MiB, and exits 0 if a write fails (stdin EOF, not a broken pipe, is what normally ends the process). It
  never exits because of queue size: main may be blocked by a synchronous dialog.
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
`BackendState`: `starting`, `ready` (pid, runtime, platform), `unresponsive`, `restarting` (with the losses), `failed`
(`crashLoop`, `spawn` or `incompatible`, with a message and Copy details), or `stopped`.

- **Binding.** A request is bound to the current generation when made (the next one while a restart is pending) and
  written only to it; if that generation ends first it fails `BACKEND_LOST`. Nothing is re-sent or re-run, and the
  backend never retries commands (query sessions use `ConnectRetryCount = 0`).
- **Ids never cross generations.** `ConnectionInfo` and result keys carry the generation; main refuses a lost
  connection's id (`CONNECTION_LOST`) before sending and answers its disconnect and session close locally.
- **Unexpected loss** (exit, GOAWAY crash, protocol break, or no HELLO within 20 s): every written and queued request of
  that generation fails `BACKEND_LOST`, port streams end, its connections become lost, its results are dropped, and the
  next generation starts after 0 s, 1 s, then 2 s. The third unexpected loss within 120 s trips the breaker
  (`failed (crashLoop)` until the user restarts); 300 s of continuous readiness resets delays and breaker. Spawn failures
  (`ENOENT`, `EACCES`) and incompatible builds fail at once. In development a missing `Varia.Backend.dll` is a spawn
  failure (checked before every launch, else `dotnet` would read as a crash loop).
- **Silence.** Main sends PING every 5 s; any frame counts as liveness. After 15 s without one the state is
  `unresponsive` and a banner offers **Restart now**; only a frame returns it to `ready`. A silent backend is never
  killed automatically (a restart rolls back open transactions). The watchdog ticks every second; a tick more than 2 s
  late (main stalled) restarts the silence window, and every silence decision first yields one turn for frames already
  in the pipe. `powerMonitor` suspend pauses silence decisions entirely; resume restarts the window.
- **Manual restart** (**Restart SQL Backend…**, **Restart now**) asks first when servers are connected ("Restart the SQL
  backend?" / "All {n} connections close and uncommitted transactions are rolled back.", or "The connection closes…" for
  one), closes the generation gracefully (stdin end, 2 s, then kill; 130 s while a Create Catalog is pending), starts the
  next at once and resets the breaker. **Reload** of the workbench restarts the backend the same way, without a notice,
  so no session outlives its page.
- **Lost renderer.** When the workbench renderer stops, main resets the page's state, restarts the backend once, then
  asks "Workbench stopped" (**Reload** or **Close**); the reload that follows restarts nothing. Its details, and those of "Workbench not
  responding" and "Reload workbench", name AutoRecover's copies when that page's generation has any. On Windows a backend spawned during a renderer launch can inherit its channel handle and hide its
  exit, so main also polls the renderer process every second and handles an exit Chromium has not reported exactly as
  Chromium's own report, once per renderer (whichever comes second is ignored). **Reload** waits up to 5 s for Chromium
  to see the stop, else opens a new window in the same place (a close or quit the lost page could not finish goes to that
  window's page); **Close** closes such a window at once.
- **Quitting** waits for the backend to stop (stdin end, 2 s, then kill; up to 130 s with a pending Create Catalog) and
  for any generation a restart is still closing. Meanwhile the app has no window and releases the single-instance lock.
  Closing the last window starts no new backend unless the app keeps running (macOS).
- **Reconnect.** A lost connection stays in Object Explorer as "{server} — connection lost" with **Reconnect…** and
  **Remove**. Only Reconnect (prefilled; main fills a remembered password for the same credentials) replaces it, moving
  its query tabs; their first execution starts with "This query opened a new SQL session. The previous session ended
  when the SQL backend restarted, so its SET options, temporary tables, and open transaction no longer exist."

## Limits

| Item | Value | Enforced by |
| --- | --- | --- |
| Request body (main → backend) | 4 MiB; a 1,000,000-character script is at most 3,000,000 UTF-8 bytes | main before writing (`TOO_LARGE`); backend skips larger |
| Response body (backend → main) | 16 MiB | backend (`RESPONSE_TOO_LARGE`); main skips larger |
| Event body | 256 KiB; `resultSet.*` 4 MiB | backend |
| Control decoding | depth 16; 4,096 map entries; 1,048,576 array items; 128-byte keys; integers within ±(2⁵³ − 1) | both |
| Page | 1 – 4,096 rows and columns; sealed at 256 KiB or 4,096 rows; first page at 64 rows or 20 ms; idle seal 200 ms | backend; checked by the worker |
| Encoded row | 8 MiB; later cells become truncated prefixes | backend |
| Stored cells | text 65,535 characters; xml, json and showplan 2,097,152; vector 65,535; binary and CLR types 32,766 bytes | backend |
| Result sets kept per query | 1 – 1,000 (default 10) | zod and backend |
| Rows stored per query | 0 – 2,147,483,647 (0 = budget only) | zod and backend |
| Result budget | `clamp(available memory / 4, 256 MiB, 16 GiB)`, or the Options limit up to three quarters of memory; 50 % per query; none under high system memory load | backend |
| Messages | 1,000 entries / 1,000,000 characters, then up to 20 more errors; error text 16,384 characters | backend |
| Descriptors per summary | 8 MiB (bounded per set by names, types and 120 bytes per column) | backend |
| FOR XML / FOR JSON value | 2,097,152 characters, the rest marks it truncated | backend |
| Row sizes a request | `results.rowBytes`: 1 – 16,384 rows (`rowSizes.maxRows`) | zod and backend |
| Shown results a set names | `results.visibility`: 0 – 4,096 distinct ids (`limits.visibility.maxResults`, `ResultVisibility.MaxResults`), `seq` 1 – 2^31 − 1, `source` a UUID | zod and backend |
| Row identities | `results.rowIds` 1 – 16,384 rows; `results.findRows` 1 – 10,000 ids, 100,000 matches (`limits.identity`); 8 bytes a row (plus a set of the first 32,768 rows) while identifying, 8 kept, under the query budget | zod and backend |
| Result diffs | context -1 – 100 rows, 64 one-sided column names each side, 1 – 16 key columns (`limits.diff`); look-alikes over at most 1,000 removed and 1,000 added rows and 4,000,000 comparisons; about 74 bytes a left row and 36 a right row (`ResultDiffer.WorkingBytes`) and 12 a differing cell while aligning; the diff's rows under the query budget, whole or refused; the change index at 3 bytes a stored row, 8 bytes per 4,096 rows of running totals, 64 bytes a look-alike row and 1 KiB, under the same budget and refused with the diff (`DiffIndex.BytesFor`), plus 4 bytes and 8 per 64 pairs for each cut row of the one-row layout (`DiffIndex.CutBytes`), and 8 bytes per 4,096 positions of a view's totals; the one-row layout at most 2,046 pairs (`limits.diff.maxEntryPairs`); a replace's allowance of the replaced comparison's charge on the query's limit, ended with it; `overview` at most 512 buckets; a kind filter 1 – 4 kinds | zod and backend |
| Sorted views | 0 – 16 keys and 0 – 16 filters (at least one), 4,096 distinct values a filter, 256 cell ranges a selection, 4,095 rows a `keepRows` filter (`limits.transpose.maxRows`), 1 – 64 ids a `results.viewClose`, 8 views a result (`limits.views`); 8 – 16 bytes per row and key or filtered column while building (plus ranked or whole text, date or binary key values while there is room), 4 bytes a row kept, under the query budget | zod and backend |
| Transposed Copy and Save | `transposed` boolean; `headerColumn` 0 – 4,095, a shown column, only with `transposed`; at most 4,095 source rows a part (`limits.transpose.maxRows`), the rest counted in `capped`; a copy still under `maxBytes` and 64 parts of 64 ranges | zod and backend |
| Pivots | 0 – 8 row columns, 1 – 16 values, 100,000 row groups, 256 column groups, 4,000,000 figures, refused past any (`INVALID_PARAMS`); column-group names cut to 128 characters (`limits.pivot`); a sort key per grouped column and 12 bytes a row while grouping, and the figures, under the query budget | zod and backend |
| Search in results | 1 – 1,024 characters, 1 – 10,000 matches an answer plus its last row's columns (`limits.search`); no budget held | zod and backend |
| Column profiles | 0 – 32 columns a request (`limits.profile`), 20 buckets, distinct exact to 16,384, values cut to 256 characters; working memory under the query budget | zod and backend |
| Distinct values | every distinct value of a column in a snapshot, 24 snapshots a result, windows of 1 – 512 values and ticks of 1 – 512 groups, 1 – 64 ids a close (`limits.distinct`), values cut to 256 characters, search 1 – 1,024 characters; working memory and each snapshot under the query budget | zod and backend |
| Copy | 64 MiB of UTF-8 (estimated before any work; main cancels past 65 MiB received); DATA ≤ 1 MiB; 16 MiB initial credit; 120 s; one per window | backend and main |
| Save Results As | one per window; 1 MiB writes; no deadline; suggested name ≤ 128 characters, path ≤ 32,767 | main and backend |
| Job progress | EVENTs every ≥ 250 ms; pushed to the renderer ≤ 4 a second | backend and main |
| Action progress | EVENTs every ≥ 250 ms plus each step's start, the last held one at the interval's end; pushed ≤ 4 a second per request (new step at once, the latest held one at the interval's end); step 0 – 519, percent 0 – 100; renderer tracks ≤ 128 requests | backend, main and renderer |
| Long object actions | 1 per Varia connection, 2 in all, waited ≤ 30 s, then `BUSY`; a closing generation waits 10 s plus the action's cleanup budget plus 5 s | backend and main |
| Pending requests in main | 256 per generation plus 32 for control-lane methods; 32 MiB queued for stdin | main |
| Connection environment | `environment` option: absent (None) or 1 – 32 characters after trimming, no control, format, line or paragraph separator characters; stored in `mssql-connections.json` (Set Connection Environment, `varia:connections-environment`, takes the same label and the live connection's options and changes only that entry's label), never in the connection string | zod (main) and backend |
| Session prompts | 1,024 queries, names ≤ 512 characters, 10 listed by name; 15 s for cancelled queries to stop | zod and renderer |
| Files main opens | 32 at a time (Open, command line, second instance, macOS open-file, drop); paths ≤ 4,096 characters; errors ≤ 600 characters; change checks 2 at a time (counting those past their 2 s), none again for a file whose last has not settled | zod and main |
| Recent Files | 50 entries in `recent-files.json` (≤ 256 KiB); 1 – 24 shown; names ≤ 260 characters; menu paths ≤ 60 | zod and main |
| AutoRecover | 64 records and 256 MiB in `WorkbenchAutoRecover/`, 32 MiB each, read or written; text ≤ the kind's limit (5,000,000 characters for a query, 4,194,304 for a value, 8,388,608 for a plan); names ≤ 512, servers ≤ 256, databases ≤ 128 (BigQuery datasets ≤ 1,024), paths ≤ 4,096 characters; 256 ids a discard; every 1 – 60 minutes, kept 1 – 90 days | zod, renderer and main |
| Server file picker | paths 1 – 260 UTF-16 code units, absolute, no U+0000 – U+001F or `*?"<>|`; ≤ 2,000 entries a folder (`truncated`), 10 s a listing (15 s deadline) | zod and backend |
| Restore Database | 1 – 64 backup files (server paths as above); ≤ 1,024 databases and 1,024 sets a history or media read (`…Truncated`); ≤ 1,024 sets and 1,000 moves a restore; a file restore ≤ 1,024 sets, 256 files, 256 filegroups, 2,100 parameters; set names ≤ 128, ids ≤ 36 characters, LSNs ≤ 25 digits, positions 1 – 32,767; 120 s a read (130 s deadline) | zod and backend |
| Object Explorer requests | node names 1 – 128 UTF-16 code units, or a kind's own bound up to 260 (`maxName`, only kinds without folders or rows of their own); other identity names (SSIS folders, projects) 1 – 128; no U+0000; pages of 1 – 2,000 nodes; cursors ≤ 1,650 characters; 1 – 256 ids a cancel | zod and backend |
| SSIS requests | folder, project, environment and other names 1 – 128 UTF-16 code units, package names 1 – 260, no U+0000; 1 – 64 ids a cancel; describe lists ≤ 2,048 rows, values ≤ 4,000 characters, answers ≤ about 4,000,000 bytes; revisions 64 lowercase hex characters, only for write verbs that take one; Stop Operation ids 1 – 2^53 − 1; Create Catalog passwords 1 – 128 UTF-16 code units, no U+0000 or lone surrogate, server paths ≤ 1,024 characters; error messages ≤ 2,048. `ssis.operations` args: kinds 1 – 4 and statuses 1 – 9, distinct; folder, project, caller 1 – 128, package 1 – 260; windowHours 1 – 8,760; limit 1 – 10,000 (100 – 10,000 in Tools › Options): a window ≤ 10,000 rows, ≤ 20,000 (2 × limit) read a sample and as many open ones with a baseline, ≤ 256 open ids re-read a sample | zod and backend |
| Backend concurrency | 288 requests in flight; 8 metadata slots; 1,000 query sessions; 16 concurrent `results.read`; Object Explorer statements 4 per connection and 8 in all, 1,024 registered loads; SSIS reads 2 per connection and 4 in all, 256 registered; SSIS writes 1 per connection and 2 in all, 64 registered | backend |
| Credit | 64 KiB – 16 MiB per grant (worker 4 MiB); 16 MiB outstanding per stream, 64 MiB per port; one page of overdraft | main and backend |
| Results port | 64 outstanding requests; 100 invalid messages close it; 10 opens a minute per page load | main |
| Live subscriptions | 16 per results port, 32 per backend, 8 per SQL Server; 8 probes each, 4 snapshot and 4 append tables per probe, 8 tables a tick; one unacknowledged EVENT (64 KiB initial credit), ≤ 256 KiB (catalogue worst case 192 KiB); interval 1 s – 1 h; 64 series, 16 status values of 128 characters, 8 probe errors of 2,000; sort 4 columns, filter 400 characters on 8, track 64 keys of 512; resume 256; 64 kept results; snapshot revisions ≤ 10,000 rows, append segments 200,000 rows or 32 MiB (2 segments' worth kept, ≤ 8 results a table), ≤ 10,000 new append rows a tick; 64 MiB of tables per subscription, all live tables ≤ 25 % of the result budget; facets 7 columns × 100 values × 128 characters, ≤ 32 KiB of facet text a tick; live statements 2 per connection and 8 in the backend; statement budget 0.8 × interval within 500 ms – 10 s (5 s default); back-off up to 60 s (or the interval); LOCK_TIMEOUT 1 s; connection back to the pool when idle 30 s | zod, main and backend |
| Results worker | 64 MiB / 512 cached pages (pending windows answer early past 64 MiB); windows of 4,096 rows, 262,144 cells, 4,000,000 characters | worker |
| Results grid | tiles of 128 rows × 32 columns; 512 characters per displayed cell; one window cache of 256 windows / 16,777,216 UTF-16 units; at most 12 grids mounted, 2 a frame | renderer |
| Timers | HELLO 20 s; PING every 5 s; unresponsive after 15 s; stop grace 2 s (130 s with a pending Create Catalog, which the backend waits up to 120 s for); backstop deadline + 5 s; progress ≤ 10/s; messages every 100 ms | main and backend |
| Restarts | after 0 s, 1 s, 2 s; breaker at 3 unexpected losses in 120 s; reset after 300 s ready | main |
| Registries | 1,024 lost connection ids; 4,096 abandoned request ids; 100,000 owned results per generation; stderr 32 lines × 512 characters | main |

## Connection ownership and binding updates

Connection requests use acknowledged main-owned receipts. `acceptConnectionRequest` and `pruneConnectionTargets` are
bounded, trusted-sender, main-only IPC, never generic backend access. Cancelling a request releases only its own
ownership interest. The successful receipt carries main's authoritative target and authentication evidence.

`ConnectionInfo.bindingRevision` is zero for an unchanged initial registration. Administrative `actions.execute`
results can include `bindingChanges` (at most 256 records) and `bindingChangesComplete`. Each record names the native
handle and monotonic revision, with a changed initial database and/or `passwordChanged: true`, never a password.
Partial-success results retain confirmed receipts. Main fences these actions, verifies ordering, and updates its
process-local equality evidence and durable credential pins.

The main-only `varia:connection-bindings-changed` event (`onConnectionBindingsChanged`) carries the generation, an
optional bounded warning, and at most 200 changes with target ID, handle, increasing main revision, sanitized options
and authentication evidence. Strict schemas reject unknown or secret fields. Consumers must match the current target,
handle, generation and principal; the channel cannot establish another account or endpoint. See
[main connection ownership](connection-ownership.md) for mutation and checkpoint ordering.

## Error codes and fixed sentences

Failures reach the renderer as `{ ok: false, error, code, details? }`; messages are complete sentences shown as they are.

**Connect details.** `details` comes with a failed `connections.connect` or `connections.databases` open, and with
`BACKEND_ERROR`; the Connect dialog shows them in **Error details** under a failed Connect or **Load databases**, as SSMS
does. Shape: `{ number?: int32, state?: 0–255, class?: 0–255, server?: str ≤ 256, reason?: 'certificate', exception?: str
≤ 512 }`: SqlClient's first error and the server that answered (the typed server when SqlClient names none). `reason`
'certificate' means the server certificate is untrusted by chain or name (`SEC_E_UNTRUSTED_ROOT`,
`SEC_E_WRONG_PRINCIPAL`, `CERT_E_UNTRUSTEDROOT`, `CERT_E_CHAINING`, or an `AuthenticationException` about the
certificate; never `CERT_E_WRONG_USAGE`); the dialog then offers **Trust server certificate and connect**, except under
Strict encryption or a pinned Server Certificate or Host Name in Certificate. An unexpected-exception `BACKEND_ERROR`
carries only `exception`: types and HRESULTs from the outer exception inwards, at most four
(`System.InvalidOperationException (0x80131509) > System.DllNotFoundException (0x80131524)`), never messages. Details
never hold the connection string or password; main treats details with other members or out of bounds as a contained
violation.

**Kerberos** (integrated authentication on Linux and macOS through managed SNI). When the Negotiate token cannot be
built SqlClient reports only error 0, class 11, "Cannot generate SSPI context.", so the backend asks GSSAPI for the
default initiator credential (`gss_acquire_cred`, no KDC contact) and answers `AUTH_UNSUPPORTED` when the GSSAPI library
is missing (what to install), or `AUTH_KERBEROS` for a missing or expired ticket (run `kinit`) or one that does not
reach the server (the SPN). On Windows, SSPI failures stay `SQL_ERROR`. A ticket expiring while connected maps the same
way, without `details`, on every later open: a query tab's session (`query.execute` answers `AUTH_KERBEROS` like
`SESSION_LOST`; the next execution opens a new session), `databases.list`, `tables.columns` (error response), and
`explorer.children` and `scripting.script` (a retryable `AUTH_KERBEROS` value: on the node, and as Script As'
`result.error`, "Could not script dbo.Orders: " then the advice). Connect sets `Pool Blocking
Period=NeverBlock` so a retry after `kinit` is not answered with SqlClient's cached failure.

**BigQuery** failures answer `AUTH_EXPIRED` (a Google sign-in to repeat, or no credentials found), `AUTH_KEY_FILE` (a key,
configuration or ADC file Varia cannot use, naming the field and never the content), `API_DISABLED`, `BILLING_DISABLED`,
`QUOTA`, `LEGACY_SQL`, `PERMISSION_DENIED` (the permission and project), `AUTH_IDENTITY` (a credential now signing in as
another account), `NOT_FOUND`, `BACKEND_ERROR` (Google's 5xx), `TIMEOUT`, and `CONNECTION_LOST` when Google cannot be
reached. A query adds `LOCATION_MISMATCH` (its dataset is in another location; the text names both), `RESULT_TOO_LARGE`
(over BigQuery's 10 GB result limit), `COST_CAP` (over the connection's maximum bytes billed, naming the cap) and
`SQL_ERROR` (BigQuery's own text); a session close adds `JOB_RUNNING` (a job still runs in the session, which is kept); a query's failures are its summary's `error`, as SQL Server's are. [BigQuery's Errors](bigquery.md#errors) has each row's text and recovery.

**Microsoft Entra** failures answer `AUTH_ENTRA` (Entra Integrated off Windows answers `AUTH_UNSUPPORTED` before
opening). Connect and Load databases `details` are number 0, class 11, state 0 and the server, except AADSTS50126
(invalid user name or password) and AADSTS7000215 (invalid client secret), which carry that number for main's
remembered-password forget rule. Known causes (cancelled or unopenable browser, those AADSTS errors, MFA required under
Entra Password, no managed or default identity, a refused authority or resource, the 3-minute limit, a token cache cleared while the
browser waited, a browser sign-in as another account than the user name entered) get Varia's own message; otherwise SqlClient's first line plus MSAL's or Azure.Identity's
text. Messages are at most 2,000 characters on one line, with anything shaped like a JSON Web Token redacted. Login
failed (18456) on an Entra connect adds "If you were recently granted access, choose Help › Clear Entra ID Token Cache,
then connect again." Later pool opens answer `AUTH_ENTRA` as Kerberos's do, plus retryable values for the object
actions.

**`AUTH_IDENTITY`**: a newly authenticated native connection has no usable stable principal proof, or its verified
SQL/Windows SID or Entra tenant/object identity differs from the target's pinned account. The backend closes it before
any caller SQL; an explicit reconnect must resolve it. Nonretryable in Explorer, scripting, object actions, SSIS and Activity Monitor;
terminal for live probes. Display login text is never identity proof.

| Origin | Codes |
| --- | --- |
| Backend | `INVALID_REQUEST`, `INVALID_PARAMS`, `METHOD_NOT_FOUND`, `BUSY`, `CANCELLED`, `TIMEOUT`, `SQL_ERROR`, `SMO_ERROR`, `BACKEND_ERROR`, `NOT_CONNECTED`, `NOT_FOUND`, `DUPLICATE_QUERY`, `DUPLICATE_REQUEST`, `SESSION_BUSY`, `SESSION_LOST`, `SESSION_CLOSED`, `SESSION_TARGET`, `SESSION_LIMIT`, `AUTH_UNSUPPORTED`, `AUTH_KERBEROS`, `AUTH_ENTRA`, `AUTH_IDENTITY`, `AUTH_EXPIRED`, `AUTH_KEY_FILE`, `API_DISABLED`, `BILLING_DISABLED`, `QUOTA`, `LEGACY_SQL`, `PERMISSION_DENIED`, `LOCATION_MISMATCH`, `RESULT_TOO_LARGE`, `COST_CAP`, `JOB_RUNNING` (BigQuery; [Error codes](#error-codes-and-fixed-sentences)), `REMOTE_RESULT`, `REMOTE_EXPIRED` (windowed BigQuery results; [Remote results](#remote-results)), `UNSUPPORTED_PROVIDER` (a method for another engine's connection; [Providers](#providers)), `INVALID_SCRIPT`, `TOO_LARGE`, `RESPONSE_TOO_LARGE`, `RESULT_NOT_FOUND`, `RESULT_RELEASED`, `VIEW_NOT_FOUND`, `IDENTITY_NOT_FOUND`, `EXPORT_FAILED` (message: one token), `RESULT_OPEN`, `BUDGET_STOPPED` (a pivot or diff of a query that stopped storing; [Pivots](#pivots)), `DIFF_KEY_TRUNCATED` (a `results.diff` key column holds a truncated value; [Result diffs](#result-diffs)), `DIFF_ROWS_TOO_LARGE` (an All rows `results.diff` whose stored rows do not fit; [Result diffs](#result-diffs)) |
| GOAWAY | `PROTOCOL_ERROR`, `PROTOCOL_UNSUPPORTED`, `BACKEND_CRASH` |
| Main | `BACKEND_LOST`, `BACKEND_UNAVAILABLE`, `CONNECTION_LOST`, `SESSION_LOST` (`query.session.state` of an ended generation or with no backend), `RESULT_UNAVAILABLE`, `TOO_MANY_REQUESTS`, `STREAM_PROTOCOL`, `PORT_CLOSED`, `TIMEOUT`, `CANCELLED` and `DUPLICATE_REQUEST` (Object Explorer loads, scripting, object actions and SSIS requests), `JOB_BUSY`, `TOO_LARGE` and `INVALID_REQUEST` (results jobs), `STALE` (a shortcuts save based on an older revision), `UNSUPPORTED_PROVIDER` (refused before sending), `DUPLICATE_REQUEST` and `NOT_FOUND` (live streams of the results port); an unknown backend code becomes `BACKEND_ERROR` |
| Renderer | `PAGE_INVALID`, `RESULT_DECODER_FAILED` |

| Code | Sentence |
| --- | --- |
| `BACKEND_LOST` | "The SQL backend stopped before answering. The request was not retried." |
| `BACKEND_LOST` (`results.remoteQuery`) | "The SQL backend stopped while a result was loading into memory. The load was not re-run, and the result is gone with the backend." |
| `BACKEND_LOST` (`query.execute`) | "The SQL backend stopped while this script was running. It was not re-run. Statements that finished before the failure may have taken effect; SQL Server rolls back the session's open transaction when it detects the closed connection." |
| `BACKEND_LOST` (reload) | "The workbench was reloaded." |
| `CONNECTION_LOST` | "This connection was lost when the SQL backend restarted. Reconnect to continue; its sessions, temporary tables, and open transactions are gone." |
| `BACKEND_UNAVAILABLE` | "The SQL backend is not running. Use Restart SQL Backend from the command palette."; while closing, "The application is closing."; for a failed start, the spawn or incompatible sentence below |
| `RESULT_UNAVAILABLE` | "These results are no longer available because the SQL backend restarted." |
| `SESSION_LOST` (main, `query.session.state` of an ended generation or with no backend) | "The SQL session ended with the SQL backend, so SQL Server rolled back its transaction." |
| `TIMEOUT` (main) | "The SQL backend did not answer within {n} seconds. The request was cancelled." |
| `TIMEOUT` (backend) | "The operation exceeded its time limit of {n} seconds." ("…its time limit." for the backend's own limits) |
| `TOO_LARGE` (main) | "The request is too large to send to the backend. Execute a smaller script or selection." |
| `TOO_MANY_REQUESTS` | "Too many pending backend requests."; for a 17th live stream on the results port, "Too many live views are open in this window. Close one and retry." |
| `DUPLICATE_REQUEST` (results port, live) | "This live view is already open." |
| `UNSUPPORTED_PROVIDER` (main) | "This command is not available for this kind of connection." |
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
| Status bar | "Starting SQL backend…", "Ready" (tooltip: runtime, SMO and SqlClient versions), "SQL backend not responding…", "Restarting SQL backend…", "SQL backend unavailable" |
| Banner: not responding | "The SQL backend is not responding. You can keep waiting, or restart it; restarting closes all connections and rolls back uncommitted transactions." **Restart now** |
| Banner: unexpected restart | "The SQL backend stopped unexpectedly and was restarted. {n} connection(s) were lost and {m} running query(ies) were stopped; nothing was re-run." ({m} counts scripts and BigQuery loads into memory) **Reconnect…** **Dismiss** |
| Banner: manual restart | "The SQL backend was restarted. {n} connection(s) were closed." **Reconnect…** **Dismiss** |
| Banner: crash loop | "The SQL backend stopped repeatedly and was not restarted again." **Restart SQL Backend** **Copy details** |
| Banner: cannot start | Development: "Could not start the .NET backend. Install .NET 11 and run npm run backend:build." Packaged: "Could not start the SQL backend. Reinstall Varia SQL Manager." |
| Banner: different build | "The SQL backend is from a different build (protocol {x}, expected 2{; missing: method}). Run npm run backend:build, then restart." (packaged: "Reinstall Varia SQL Manager.") |
| `SESSION_LIMIT` | "This query was not executed: 1,000 query tabs already hold SQL sessions, the most Varia SQL Manager keeps open. Close query tabs you no longer need, or disconnect idle ones (Query > Connection > Disconnect), then execute again." |
| `SESSION_LOST` (commit) | "The SQL session was lost, so SQL Server rolled back its transaction. Nothing was committed." While the commit ran: "The SQL session was lost while committing, so it is not known whether its transaction was committed. Check the data before running the work again." After a commit that never answered (state read too): "The SQL session was lost after a commit that did not finish (it was cancelled or timed out), so it is not known whether that commit took effect. Check the data before running the work again." |
| Execute hint, lost connection | "This query's connection was lost when the SQL backend restarted. Reconnect to run queries." |
| Running placeholder | "Your query is running… {n} rows" |

**Copy details** lists the generation, status, last loss and reason, exit code and signal, uptime, losses in the last
120 s, the protocol, runtime and OS, and the stderr lines.

## Display formats

The backend formats every non-binary value into the text SSMS 2022 shows (`CellFormat.cs`); the renderer never formats
SQL types. Every sample is a case in `tests/fixtures/sql-display.json`, checked against `CellFormat` offline and against
SQL Server by the live type matrix. Reads use `CommandBehavior.SequentialAccess`, call `IsDBNull` first, and read each
column once, in order, with a reader chosen per result set from the schema table. A long value is kept up to its cap and
the rest read past in 8,192-unit chunks (text and ntext through `GetTextReader`; json as UTF-8 bytes through `GetBytes`,
decoded by the backend, because SqlClient 7.1's json `GetChars` and `GetTextReader` are broken for multi-byte text).
Rows not stored (past `maxRows`, after the budget stops storing, or in a set not kept) are read past with a synchronous
`Read` on a dedicated thread when their set has a long column, so a slow server row never occupies pool threads. Either
way nothing near a huge value's size is held, and a cancel stops it.

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
| xml, the showplan column | the text as SqlClient serialises it, role `xml` / `plan`, up to 2,097,152 characters (streamed; see below) | `abc`, `é<a b="1" />` |
| json (SQL Server 2025) | the text, role `json`, up to 2,097,152 characters | — |
| vector (SQL Server 2025) | float32 values, shortest form, role `vector` | `[0.1,2,-3.5]` |
| binary, varbinary, image | `0x` + uppercase hex, up to 32,766 bytes | `0x0001FF`, `0x` |
| timestamp, rowversion | `0x` + uppercase hex | `0x00000000000007D1` |
| hierarchyid, geometry, geography, other CLR types | serialized bytes as `0x…`, as SSMS shows them; role `udt` | — |
| sql_variant | its base type's format; `SqlBinary` as `0x…` text. SqlClient reports neither the base type nor its scale, so date, time, datetime2 and datetimeoffset show 7 fractional digits (a date also shows `00:00:00.0000000`) and smalldatetime shows milliseconds | `2026-10-08 00:00:00.0000000`, `12:34:56.0000000`, `2026-10-08 12:34:00.000` |
| NULL | `NULL`, styled with `resultsGrid.nullForeground` | — |

**xml streaming** (`Results/SequentialXml.cs`). XmlReader parses the sequential stream as UTF-16 as it arrives; text
is copied out in 8,192-character chunks and, past the cap, the rest is read as bytes without parsing (a 200 MB value
allocates under 32 MB). Because XmlReader buffers a whole start tag, comment or processing instruction, the stream ends
once 8 MiB pass with no new output; a node just inside that window is read whole, growing XmlReader's buffer to about
50 MB allocated in all. A cut value keeps its first 2,097,152 characters, marked truncated: what was written
before the cut node, the parent's start tag closed, then the node's raw text (`<r><a b="yyy…`, or `<a b="yyy…` for the
root), kept from each node's `<` in pooled 32 Ki-character chunks (at most the cap's worth and one 4,096-character read more). A cut node whose start the feed could not keep (it starts
in the same 4,096-character read as the end of a start tag read whole that had passed the cap, and was shrunk below it by
character references or white space between attributes) keeps only what was written before it, the parent's start tag
closed; a node starting after that read keeps its start again. A NameTable past 4,096 names or 262,144 characters is
dropped at the cell's end; a set's xml cells share one buffer (a small cell allocates about 28 KB; the live suite checks
under 36 KB). SqlClient 7.1's `GetXmlReader` mis-detects encoding, so the stream is opened through SqlClient internals
(pinned by an offline check) with `GetXmlReader` as fallback; a malformed tail past the cap keeps the prefix with a
column message.

SSMS runs on .NET Framework, whose default float and real text has 15 and 7 significant digits, so `PI()` shows as
`3.14159265358979`; negative zero shows as `0`. The money and float samples (`1.00`, `123.4567`, `1E+20`,
`3.14159265358979`, `3.141593`) await the owner's check against SSMS 2022 on Windows; a correction is one line in
`CellFormat.cs` plus its fixture line. The json and vector paths are checked only against a 2025 server; CI runs 2022
and reports that block skipped.

## Security

- **Renderer → main.** Invoke requests pass `trusted()` and strict zod; port messages pass `portRequestSchema`,
  ownership and generation checks, clamped credits, an outstanding-request cap, an invalid-message limit and an open
  rate limit. Main never forwards renderer bytes: it re-encodes validated objects. `debug.*` methods are in no renderer
  schema.
- **Backend → renderer.** Unary responses and events are decoded in main under the control limits; pages are opaque to
  main, size- and credit-checked, copied exactly, decoded only in the results worker, and rendered as text.
- **SQL Server data is untrusted content**, bounded by the cell, row, page and budget limits.
- **Paths.** The renderer never names a file: main takes paths from its own dialogs, the command line, a second
  instance, macOS open-file, Recent Files and its own stored records, and the page uses opaque file ids. A drop is read
  in the preload's isolated world from trusted events only and sent on `varia:files-dropped` (not on `window.varia`);
  main accepts at most 32 absolute paths to regular files, read as Open does (5 MB). Main also reopens paths it stored
  in its profile (hot exit's session, an AutoRecover record's file, Recent Files). A packaged smoke run that keeps its
  debugging port (`VARIA_PACKAGED_SMOKE=1`) opens only paths its own dialogs returned in that run, refusing handed-in
  files (`launchFilesRefused`) and profile paths (`profilePathsRefused`): the session and AutoRecover stores hand out
  records without the file's path (a kept query reopens with its text and no file; a clean tab that kept only its path
  does not reopen), and Recent Files neither reads nor writes `recent-files.json`, listing only that run's dialogs'
  files. Other store content (text, names, settings, layouts, themes) is still read from the profile.
- **AutoRecover** (`varia:recovery-write`, `-list`, `-take`, `-discard`, strict zod) writes query text only, never
  results, connections or credentials, to `<userData>/WorkbenchAutoRecover/<uuid>.json` (a lower-case uuid; a file named in upper case still counts against the caps,
  is quarantined rather than offered, and is purged; folder 0700, records 0600 on POSIX, atomic, never logged). The page
  names records by uuid and files by opaque id. A record belongs to the main process and renderer generation that wrote
  it (the page the main frame had committed when the message arrived, so a page being replaced by a reload still writes as
  itself); a page may write only new or owned records and is
  offered the others, which taking moves to it once: a record is handed over only while it is offered, so it never backs
  two tabs. Writes stop while AutoRecover is off and once a close is approved; an approved close deletes the page's
  records first. Invalid records are quarantined and never offered; records, quarantined records and interrupted writes
  older than the retention are deleted at startup, only once settings were read, and not when settings.json held a
  retention that was reset because the file or that value was invalid.
- **Hot exit** (`varia:session-write`, `varia:session-take`, strict zod; docs/hot-exit.md) writes open text tabs' names,
  unsaved text (untitled tabs included), line endings, file paths, server and database names to `<userData>/WorkbenchSession/session.json` on an approved
  close (0700/0600 on POSIX, atomic, at most 64 tabs and 64 MB, also the non-secret connection workspace: targets' sanitized options, expected account,
  reconnect intent and credential reference; never results, live connections, session ids, passwords, tokens or connection
  strings, never logged), kept as `previous.json` until the next run closes; an invalid file is quarantined. A close with hot exit off keeps only
  pinned tabs, or deletes both files when there are no pins. Startup and Reload Window hold their checkpoint until a
  renderer has reopened the tabs and acknowledges it with `varia:session-restored`.
- **Secrets.** Passwords exist only inside REQUEST bodies on the private pipe: never in arguments, environment,
  `BackendState`, the fake backend's call log, traces or stderr. Lost connections keep their options without the
  password. A remembered password is Electron `safeStorage` ciphertext in `mssql-saved-passwords.json`, bound to its server,
  login and TLS settings by a SHA-256 hash beside it, and to those, its opaque revision and the password by a check
  inside the ciphertext (a ciphertext moved between bindings, a rewritten hash or revision is refused); an unchanged secret keeps its revision, replacement rotates it, and legacy ciphertext without one is picker-only. Main serializes
  secret operations and gates saved-binding attempts through completion, so a rejected revision cannot be tried again by
  queued reconnects, even if removing its ciphertext fails; temporary keyring/network/TLS failures
  keep the entry. Main decrypts (async API only) into a `connections.connect` or `.databases` request with that binding
  and an empty password, after `validateRequest`; the frame is zeroed. The renderer only learns which entries have one.
- **Test seams** are honoured only when `VARIA_SMOKE_TEST=1` and the app is not packaged: `VARIA_TEST_BACKEND` (with an
  absolute `VARIA_TEST_NODE`), `VARIA_BACKEND_TEST_HOOKS`, `VARIA_RESULT_BUDGET_BYTES`, `VARIA_BACKEND_LIVENESS_MS`,
  `--varia-test-mode` (`window.__variaResults`, `window.__variaGrid`, `window.__variaRecovery.flush()`),
  `globalThis.__variaTest`, `VARIA_TEST_SAFE_STORAGE=test` (a reversible test cipher instead of `safeStorage`), and
  `VARIA_TEST_FOLLOW_SYSTEM_MOTION=1` (`--varia-follow-system-motion`: the renderer reduces motion whenever the emulated
  media asks, without the setting).
  `VARIA_IPC_TRACE=1` (unpackaged only) logs each frame's kind, id and length to stderr, never a body.

## Testing

docs/testing.md has the environment variables and rules; the protocol-specific pieces:

- **Shared vectors and golden pages.** `tests/fixtures/ipc-vectors.json` (control bodies, frames and pages, valid and
  invalid) is checked by both codecs; `tests/fixtures/pages/*.page` are written by the .NET checks
  (`VARIA_UPDATE_GOLDEN=1` after an intended format change) and decoded and re-encoded byte for byte in TypeScript.
- **Fuzzing.** Seeded on both sides; a failure prints its seed (`VARIA_FUZZ_SEED` replays it, `VARIA_FUZZ_ITERATIONS`
  raises the count). A differential test compares the TypeScript codec with `@msgpack/msgpack` (devDependency, that
  test only).
- **Fake backend.** `tests/fixtures/backend.mjs <mode>` speaks v2 through the real wire code under Node's type stripping,
  with a mode per misbehaviour (`silent`, `exit`, `crash-after`, `bad-magic`, `oversize`, `truncated`, `no-hello`, `v1`,
  `wrong-version`, `missing-method`, `late`, `credit-overrun`, `seq-gap`, `unknown-id`, `contained`, `unresponsive`,
  `live-overrun`, `live-data`, `live-big`, `live-seq-gap`, and others; echo mode runs `live.subscribe` as a few status
  ticks under stop-and-wait) and a `workbench` mode (its `live.subscribe` runs `debug.synthetic` as the backend does) for
  the Electron smoke tests, controlled through `VARIA_TEST_BACKEND_DIR` (`calls.jsonl`, `hold/<method>`, `allow/audits`, `crash-next`,
  `fail-commit`, `silent-<generation>`). Each session counts its scripts' BEGIN TRAN, COMMIT and ROLLBACK and notes SET
  NOEXEC, PARSEONLY, FMTONLY and SHOWPLAN_*, so `query.session.state` answers as SQL Server would. A script whose first line is
  `-- varia-fake: sets=W1*200000@50000,N1*100,X1*5000,L1*3 messages=40 errors=2 memory=0.92 hold` streams synthetic sets (`tests/fixtures/backend/shapes.mjs`;
  `@rate` is rows a second, `M1*n` is n one-row sets); `results.copy` and `results.export` use `src/shared/results/text-writer.ts`, and `hold/results.export` pauses an export after each page
  (or line of a transposed one) so a test can cancel it mid-save.
- **Copy and Save goldens.** `tests/fixtures/results-text/cases.json` holds small result sets with the exact Copy, CSV,
  TSV and JSON bytes; the C# writer (through the real jobs) and the TypeScript twin are both checked against them.
- **Real backend.** `tests/backend-sidecar.test.ts` drives the Release build over `BackendConnection`: malformed frames,
  stdout purity and, with test hooks, synthetic results, streams, cancellation, the budget, and live subscriptions whose
  every frame must pass main's schemas.
- **Live path.** `tests/live-protocol.test.ts` (main's live path over the fake backend, then the real worker core,
  `ResultClient` and a `LiveService` view), `tests/live-service.test.ts`, `tests/live-ring.test.ts`,
  `tests/live-status.test.ts`, `tests/chart-view.test.ts` and `tests/live-grid.test.ts`.
- **Smoke.** `scripts/backend-smoke.mjs` (restarts, lost connections, crash loop, silent and protocol 1 backends, UI
  responsiveness over a million stored rows, a real `debug.synthetic` subscription), `scripts/live-smoke.mjs`,
  `scripts/chart-smoke.mjs`, `scripts/live-grid-smoke.mjs`, and `scripts/results-smoke.mjs` (fake sets, then a real
  server with `VARIA_TEST_SQL_SERVER`).

## Benchmarks

```sh
npm run bench                                   # node harness: codecs, main ↔ Release backend ↔ results worker, grid models, chart draw, plan layout, object search
npm run bench:e2e                               # Electron, real backend with test hooks (add -- --live for SQL Server)
npm run bench:grid                              # Electron, the results grid on the fake backend (add -- --live for SQL Server)
npm run bench:startup                           # Electron, real backend: time to ready, and memory idle, with tabs, holding a result
node scripts/check-bench.mjs [--enforce]        # compare with tests/bench/floors.json; markdown to $GITHUB_STEP_SUMMARY
```

The harnesses need the Release backend and, for `bench:e2e`, `bench:grid` and `bench:startup`, the built app
(`npm run check`). They write `artifacts/bench/node.json`, `e2e.json`, `grid.json` and `startup.json` and are not part of
`npm run check`. They only measure (and check that every row and cell arrived); `check-bench.mjs --enforce` fails when a
value is worse than its floor, or a metric with a floor was not measured (a live one only when its harness ran `--live`).
CI enforces floors on Linux (with live SQL Server); Windows and macOS report only.

- **W1** is a typical wide row: int, nvarchar(50), datetime2(7), decimal(18,2), uniqueidentifier, nvarchar(200) of 80
  characters, bit, and an int that is NULL in every fifth row (about 220 bytes encoded). **B1** is two nvarchar(max)
  values of about 4 KB. Both come from `debug.results.synthesize`, stored as query rows would be.
- **The node pipeline** runs main's real classes (`BackendSupervisor`, `BackendConnection` over stdio to the Release
  backend, `ResultsPortHost` over a `MessageChannel`, `ResultsWorkerCore` in a worker thread) reading windows of every
  row with every cell decoded (four windows in flight). Its live round trip subscribes to `debug.synthetic` every 10 ms
  and acknowledges each event 20 ms after it arrives, so the time from an acknowledgement to the next event is the whole
  loop (page → worker → main → backend → main → worker → page). Its backend start spawns six backends and times the last
  five from spawn to HELLO answered and to the first `system.health`, for the IL Release build and, with
  `VARIA_BENCH_BACKEND=<Varia.Backend executable>`, a published ReadyToRun build
  (`dotnet publish -r <rid> --self-contained -c Release`). CI's Linux benchmarks publish that build as package.yml does,
  and the bench fails unless `Varia.Backend.dll`, `Microsoft.Data.SqlClient.dll` and `Microsoft.SqlServer.Smo.dll` there
  are ReadyToRun.
- **The packed sort** stores 1,000,000 W1 rows packed (`debug.results.synthesize`'s test-only `pack`), reports the
  result shown, sorts it three times and reads the budget: a sort reads packed pages in place, so the budget may grow
  only by the view's order, never by an unpack ([page-compression-findings.md](page-compression-findings.md#stage-2-as-built)).
- **The view tiles** sort 1,000,000 W1 rows stored raw, then packed, and read 300 random 128-row tiles of the view (the
  grid's tile) through main's supervisor and the stream: the p99 of each, packed and raw. What a sorted grid on screen
  pays for being packed.
- **The live snapshot churn** runs main's live path with a worker stand-in that acknowledges each frame at once:
  `debug.synthetic.wide` stores 5,000 rows of 23 typed columns every 10 ms if it can, each revision owned, retired,
  forgotten and released one at a time, for 5 s. It reports revisions a second and backend gen2 collections per revision
  × 60 (a 1 s snapshot's minute); collections follow revisions, not the clock, and the forced collection never runs for
  live tables.
- **The grid models** (`tests/bench/grid.bench.ts`) time per-frame grid computation for a 1600 × 1000 view: selection
  blocks, scroll mapping past the scroll cap, tile planning, and the full window cache. **The chart draw**
  (`tests/bench/chart.bench.ts`) times `ChartView`'s draw of a full ring (7,200 samples) of six series over 1,600 px into
  a call-counting context.
- **The object search** (`tests/bench/search.bench.ts`) runs the .NET test program's `--search-bench` mode
  (`backend/Varia.Backend.Tests/SearchBench.cs`): one letter over a synthetic index of 1,000,000 objects in 20 databases
  (700,000 matches, far past the 20,000-candidate cap), reporting p95 of 20 warm searches and the memory one allocates,
  then a search inside 10,000 compressed procedure definitions (42 M characters) that matches none, so every one is
  unpacked and scanned (`node.search.definitionScanP95Ms`).
  Its `--find-bench` mode (`FindBench.cs`) times Find's culture matcher over 400,000 fictional multilingual cells in a
  Latin1_General_CI_AS column on one thread, with and without the pre-check (`node.find.*`). A quarter of its cells hold
  characters the fold does not vouch for (Thai, Hindi, ligatures, voiced half-width kana), so its ratio (about 1.9) sits
  below real multilingual text's. It also types a 14-letter word a key at a time into
  400,000 cells of the sentences the fold vouches for, narrowed and searching every row each key
  (`node.find.typeAhead*`, about 3.8 times); `--find-bench-messages <server> [language_id]`, run by hand, does the same
  over `sys.messages` with one SELECT. Its `--room-pool-bench` mode (`RoomPoolBench.cs`) reads 200 random 128-row tiles
  of a scattered view of 400,000 packed W1 rows and reports the memory a tile allocates and the full collections
  (`node.roomPool.*`; about 0.2 MB and none with the room pool, 23 to 33 MB and one every tile or two without it).
- **The e2e run** reads every row through `window.__variaResults` in the built app (four windows in flight), watching the
  UI thread for long tasks and frame gaps, and times 500 live ticks of `debug.synthetic` through `ResultClient.live`;
  `--live` stores a million W1-like rows from SQL Server with `maxRows: 0`, then 200,000 rows each holding a small xml
  value, and times 200 executions of `SELECT 1` in a warm tab.
- **The grid run** (`scripts/grid-bench.mjs`) drives the built app in a 1600 × 1000 window on the fake backend's
  synthetic sets: first cell painted, UI busy share while a million rows stream, `GridView.frame()` times
  (`window.__variaGrid`) during wheel scrolls and scroll bar jumps, each jump's main-thread task time (DevTools protocol),
  frame intervals while 300 columns and 300 bit columns scroll 400 px a frame for 3 s (natively and past a lowered cap),
  DOM elements, the same over a transposed grid, random-row jumps, caches after a sweep, heap growth, and long tasks.
  `--live` copies 100,000 rows and saves a million as CSV from SQL Server, comparing the text with the query's rows.
- **The startup run** (`scripts/startup-bench.mjs`) launches the built app six times on one profile and times the last
  five from main process creation to the query editor and to the status bar naming the backend, then samples the process
  tree's memory by role (idle, after 20 empty tabs, holding 500,000 W1 rows read once). Report only; part of the daily
  desktop benchmarks, not CI's.

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
| Results picker: 1,251 views of 1,000 results listed, filtered and windowed per keystroke | ≥ 2,000 ops/s | ≥ 500 ops/s | – | – |
| Object search: one letter over 1,000,000 indexed objects (700,000 hits), p95 | ≤ 75 ms | ≤ 500 ms | 55 ms (Windows, 24 CPUs) | not measured |
| Object search: memory allocated by that search, median | ≤ 16 MB | ≤ 64 MB | 9 MB | not measured |
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
| Live: `SELECT 1` in a warm tab, end to end, p50 | ≤ 5 ms | ≤ 50 ms | 0.6 ms, p99 1.3 ms (Windows, 24 CPUs, local SQL Server) | not measured |
| Grid: `resultSet.opened` → first data cell painted, median of 5 | ≤ 50 ms | ≤ 250 ms | 56 ms | 57 ms |
| Grid: UI thread busy while 1,000,000 W1 rows stream (250,000 a second) | ≤ 10 % | ≤ 25 % | 8 % | 9 % |
| Grid: `frame()` during a 3 s wheel scroll over 1,000,000 rows, p95 | ≤ 3 ms | ≤ 8 ms | 0.7 – 0.9 ms | 0.8 ms |
| Grid: animation-frame interval during that scroll, p95 / largest gap | ≤ 17.5 / 50 ms | gap ≤ 150 ms | 16.7 / 16.8 ms | 16.8 / 16.8 ms |
| Grid: scroll bar jump to a random row of 1,000,000 → painted, p95 | ≤ 50 ms | ≤ 250 ms | 64 – 71 ms | 66 – 67 ms |
| Grid: header funnel over 1,000,000 distinct values, Alt+Down → first values listed (the fake backend groups them) | ≤ 4,000 ms | reported only | 3,316 ms (Windows, 24 CPUs) | not measured |
| Grid: funnel checklist scroll bar jump over 1,000,000 values → listed, p95 | ≤ 50 ms | ≤ 500 ms | 61 ms (Windows, 24 CPUs) | not measured |
| Grid: funnel search over 1,000,000 values / OK with 1,111 ticked → grid filtered | ≤ 600 / 1,000 ms | reported only | 323 / 948 ms (Windows, 24 CPUs; the search includes its 200 ms debounce) | not measured |
| Grid: `frame()` after a scroll bar jump, 300 columns, p95 | ≤ 8 ms | ≤ 16 ms | 2.3 – 3.1 ms | 2.5 – 3.3 ms |
| Grid: main-thread task time per scroll bar jump, 300 columns / 300 bit columns, p95 | ≤ 50 / 50 ms | ≤ 170 / 260 ms | 73 – 85 / 102 – 128 ms | 75 – 76 / 99 – 129 ms |
| Grid: UI long tasks over 50 ms in those two jump segments (one retry each, the better attempt counting) | 0 | ≤ 50 | 7 – 23 | 4 – 16 |
| Grid: `frame()` scrolling across 300 columns, p95 | ≤ 6 ms | ≤ 12 ms | 0.5 – 0.8 ms | 0.7 ms |
| Grid: animation-frame interval, 300 columns scrolled 400 px a frame for 3 s, natively / past the cap, p95 | ≤ 17.5 / 17.5 ms | ≤ 60 / 60 ms | 18.4 / 18.9 ms | 21.4 / 22.7 ms |
| Grid: the same over 300 bit columns, p95 | ≤ 17.5 / 17.5 ms | ≤ 80 / 80 ms | 23.1 / 25.3 ms | 30.2 / 32.7 ms |
| Grid: UI long tasks over 50 ms in those four wheel segments | 0 | ≤ 20 | 0 | 0 |
| Grid: DOM elements, 8 / 300 / 300 bit columns | ≤ 1,500 / 4,000 / 4,000 | same | 535 / 931 / 1,811 | 535 / 931 / 1,811 |
| Grid, transposed (4,096 long-text columns as rows by 4,095 rows as columns): `frame()` after a scroll bar jump / scrolling across / scrolling down, p95 | ≤ 8 / 6 / 6 ms | ≤ 16 / 12 / 12 ms | 1.1 / 0.6 / 0.6 ms (Windows, 24 CPUs) | 1.9 / 0.9 / 0.8 ms |
| Grid, transposed: main-thread task time per scroll bar jump over the same / over 300 bit columns as rows, p95 | ≤ 50 / 50 ms | ≤ 170 / 260 ms | 32 – 47 / 41 – 66 ms (Windows, 24 CPUs) | 56 – 81 / 57 – 71 ms (Linux CI) |
| Grid, transposed: scroll bar jump → painted, p95 (each jump reads up to four tiles of 32 rows × 128 long values) | ≤ 500 ms | ≤ 2,500 ms | 378 – 700 ms (Windows, 24 CPUs) | 448 – 922 ms (Linux CI, by runner CPU) |
| Grid, transposed: animation-frame interval during those scrolls, the worse p95 | ≤ 17.5 ms | ≤ 60 ms | 17.1 ms (Windows, 24 CPUs, 59 Hz) | 23.2 ms |
| Grid, transposed: DOM elements, 4,096 long-text columns / 300 bit columns | ≤ 4,000 / 4,000 | same | 966 / 1,577 | 966 / 1,483 |
| Grid, transposed: UI thread busy while 4,095 rows of 300 columns stream in at 1,000 a second | ≤ 10 % | ≤ 25 % | 6 % (Windows, 24 CPUs) | 8 % |
| Grid, transposed: the longest UI long task in its segments | ≤ 50 ms | ≤ 250 ms | none over 50 ms (Windows, 24 CPUs) | none over 50 ms |
| Grid: UI window cache after a sweep and 300 jumps, windows / text | ≤ 256 / 16 Mi units | same | 256 / 5.8 Mi | 256 / 5.8 Mi |
| Grid: worker page cache after the same | ≤ 64 MiB | same | 64 MiB | 64 MiB |
| Grid: worker page cache after 60 jumps over 5,000 rows of 300 columns, bytes charged beyond page bytes per cached column (the column-view charge; 0 if pages were charged their wire bytes alone) | ≥ 320 bytes | same | 320 bytes (33.8 MiB for 79 pages, Windows, 24 CPUs) | not measured |
| Grid: renderer heap growth, Ctrl+End then Ctrl+Home over 1,000,000 rows | ≤ 80 MB | ≤ 150 MB | 0.1 MB | 0.1 MB |
| Grid: UI long tasks over 50 ms in the measured segments / the longest | 0 / ≤ 50 ms | reported / ≤ 250 ms | 32 / 101 ms | 18 / 70 ms |
| Grid, live: Ctrl+A, Ctrl+C of 100,000 × 8 rows → clipboard (16.7 MB) | ≤ 1.5 s | ≤ 6 s | 0.57 – 0.81 s | 0.61 s |
| Grid, live: Save Results As CSV, 1,000,000 × 8 rows (172 MB) | ≤ 3 s | ≤ 15 s | 1.5 – 2.0 s | 1.5 s |
| Startup: main process created → query editor in the page / status bar names the backend / both, median of 5 | ≤ 1,000 / 1,000 / 1,000 ms | reported only | 639 – 649 / 678 – 689 / 678 – 689 ms (Windows, 24 CPUs) | not measured |
| Memory, idle: working set of the whole tree / of Electron's processes / private bytes of the tree | ≤ 750 / 650 / 400 MB | reported only | 692 / 612 / 368 MB: main 190, renderer 172, GPU 150, utility 101, backend 62 (Windows, 24 CPUs) | not measured |
| Memory, idle: renderer / .NET backend with no connection open | ≤ 200 / 100 MB | reported only | 170 – 172 / 62 – 70 MB (Windows, 24 CPUs) | not measured |
| Memory: renderer growth per empty query tab, 20 opened | ≤ 1 MB | reported only | 0.64 – 0.73 MB (Windows, 24 CPUs) | not measured |
| Memory: backend growth holding 500,000 W1 rows (109 MB of pages) / that growth ÷ page bytes | ≤ 150 MB / 1.3 | reported only | 133 – 134 MB / 1.22 – 1.23 (Windows, 24 CPUs) | not measured |
| Memory: renderer growth after every one of those rows was read once / working set of the tree then | ≤ 220 / 1,100 MB | reported only | 187 – 203 / 1,067 MB (Windows, 24 CPUs; the worker's heap is not collected first) | not measured |

Measured in a shared Linux container (Xeon at 2.1 GHz, Node 24, .NET 10, SQL Server 2022 in Docker) with 4 CPUs and
pinned to 2 (`taskset`), as on a private repository's runner; megabytes are 10⁶ bytes. Floors sit at about half the
2-CPU values or lower, so slow shared runners never fail them; bounds (caches, DOM elements) have the bound as floor.

Notes on the figures:

- The control codec misses its target: it is a fully validating decoder for small, infrequent bodies; pages never pass
  through it.
- A result set's first page (64 rows) is announced at once; the live first window needs 100 rows, from the second page,
  announced by the next progress event (100 ms apart).
- Page bytes sent exceed distinct bytes because four adjacent windows each read the page holding their boundary (decoded
  once). The budget charge is pages, bookkeeping and column metadata against distinct page bytes forwarded. The e2e W1
  rate includes copying each page into the renderer and cloning every window's text to the UI thread.
- A jump's task time is measured around the bench's wait for its paint, so the wait must cost the main thread nothing:
  `grid-bench.mjs` looks at the view only when the grid writes its DOM (a `MutationObserver`), held by
  `tests/bench-floors.test.ts`. A jump segment that had a long task, or whose p95 is over half its floor, is measured once more and the better
  attempt (fewer long tasks, then the lower figure) counts (`scripts/fixtures/bench.mjs`). The transposed jump's floor is the 300-column jump's 170 ms; its paint
  floor of 2,500 ms is about 2.7 times the slowest CI run, so a read path three times slower fails a pull request.
- A single scroll bar jump reads its tiles at once; the grid waits for scrolling to settle (50 ms) only while it moves
  faster than three views a frame.
- Long tasks over the whole run are report only (only the longest has a floor); `results-smoke.mjs` holds each measured
  segment to no task with 50 ms of CPU time on Linux (100 ms elsewhere) and none of 250 ms by the clock (one retry), read
  from a renderer trace.
- Jumps across many columns miss their 50 ms target: each rewrites every cell in view, and styling, layout and paint of
  most of a 300 bit-column grid's ~1,800 elements takes 40 to 90 ms on these CPUs. Continuous scrolling of wide results
  misses 60 frames a second: every frame writes the cells of the rows that scrolled in (about 1,800 elements for 300 bit
  columns). Row numbers are one sticky
  column beside the rows (a sticky header per row made every row a composited layer); `results-smoke.mjs` checks that
  nothing inside a row is sticky. Rows are reordered in the DOM (for screen readers) only in the first frame after
  scrolling stops.
- The first data cell paints after two animation frames (the pane's update and the tile's arrival, 33 ms at 60 Hz) plus
  the tile's read, so the 50 ms target is missed by the read.
