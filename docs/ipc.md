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
| Result store | — | `Results/ResultStore.cs`, `ResultSetBuffer.cs`, `QueryEventSink.cs` |
| Results worker | `src/renderer/src/results/` | — |

## Contents

- [Shape](#shape)
- [Frames](#frames)
- [MessagePack subset](#messagepack-subset)
- [Handshake](#handshake)
- [Requests, deadlines, and cancellation](#requests-deadlines-and-cancellation)
- [Methods](#methods)
- [Streams and credits](#streams-and-credits)
- [Query events](#query-events)
- [Result pages](#result-pages)
- [Result store and memory budget](#result-store-and-memory-budget)
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
  `ApiResult` results, now with an error `code`.
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
| 3 | RESPONSE | backend → main | `{ result: any }` or `{ error: { code: str, message: str ≤ 16,384 } }`; exactly one per REQUEST |
| 4 | EVENT | backend → main | id of a `query.execute` request: a [query event](#query-events). id 0: `{ type: 'results.memory', usedBytes, globalBytes }` |
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
deadline, then `BUSY`), `query` uses the per-tab session path, and `results` takes one of 16 read slots.

| Method | Renderer path | Kind | Lane | Header deadline |
| --- | --- | --- | --- | --- |
| `system.health` | invoke | unary | control | 10 s |
| `connections.connect` | invoke | unary | metadata | (connect timeout, default 15) + 30 s; 0 means none. Password zeroed. |
| `connections.databases` | invoke | unary | metadata | 45 s. Password zeroed. |
| `connections.discover` | invoke | unary | metadata | 45 s |
| `connections.preview` | invoke | unary | metadata | 10 s. Password zeroed. |
| `connections.disconnect` | invoke | unary | control | 30 s; answered locally `{ disconnected: false }` for a lost connection or a failed backend |
| `databases.list`, `server.objects.list`, `tables.list`, `tables.script` | invoke | unary | metadata | 45 s |
| `query.execute` | invoke, events on the port | unary with EVENTs | query | none; backstop `timeoutSeconds + 30` s |
| `query.cancel` | invoke | unary | control | 10 s |
| `query.session.close` | invoke | unary | control | 10 s; answered locally `{ closed: false }` for a session of an ended generation |
| `results.read` | port | stream | results | 60 s |
| `results.close` | port | unary | control | 10 s |
| `debug.results.synthesize` | `__variaTest` and tests only | unary | metadata | 120 s; exists only with `VARIA_BACKEND_TEST_HOOKS=1` |

**A backend method is added in five places:** `RpcMethods` (`src/shared/contracts.ts`); `requestSchemas`
(`src/main/validation.ts`) for invoke or `portRequestSchema` for the port; a `methodPolicies` entry (a new unary method
is usually one `metadata` line); a preload or `ResultClient` method; and a `SqlService.DispatchAsync` case with its
`MethodNames` entry and record in `Contracts.cs`. A backend whose HELLO lacks a method main may call is refused, and
lists that could exceed 16 MiB must be paged (`RESPONSE_TOO_LARGE`).

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
- Query events have no credit; they are bounded where they are produced.

## Query events

EVENT frames whose id is a running `query.execute` request. Main validates each with `queryEventSchema`, stamps the
generation on descriptors, registers the result as owned on `resultSet.opened`, and forwards it on the port (or drops it
when no port is open).

| type | Emitted |
| --- | --- |
| `resultSet.opened` | When a kept result set's columns are known, before its first row; carries the descriptor |
| `progress` | At most 10 times a second per query, latest value wins; up to 64 result sets with `rowsRead`, `rowsStored`, `rowsAvailable`, `bytesStored`. A sealed page is reported at once when no progress went out in the last 100 ms, so the first rows are readable without waiting for a tick |
| `messages` | Every 100 ms or 64 KiB, only messages stored under the message caps |
| `resultSet.closed` | Once per kept result set, with its final descriptor |
| `results.memory` (id 0) | At most once a second, when usage crosses 50, 75, 90 or 100 % of the budget or changes by 64 MiB |

Events are droppable: when the backend's control lane holds 1,000 frames or 8 MiB, new events are refused, and any event
over 256 KiB is dropped. RESPONSE, PONG and GOAWAY are never dropped. The UI treats the summary as authoritative and
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
  summary must fit the 16 MiB response: kept sets' descriptors may take 12 MiB (messages the rest), so once a set's
  column list would pass that, it and later sets are counted as discarded.
- **Never unowned.** If a `query.execute` summary still cannot be encoded (`RESPONSE_TOO_LARGE`), its results are
  released at once rather than left without an owner.
- **Descriptor.** `{ generation, resultId, index, batchNumber, iteration, kind: 'rows' | 'executionPlan', columns,
  rowsRead, rowsStored, rowsAvailable (rows in sealed pages), bytesStored, truncatedCells, state: 'open' | 'complete' |
  'released', truncated?, incomplete }`. Result ids are u32 from 1 per generation and always paired with it.
- **Released** by `results.close`, the next `query.execute` on the same session, `query.session.close`,
  `connections.disconnect`, and process exit. A release fails the result's in-flight reads with `RESULT_RELEASED` after
  the current page. Every 64 MiB released, counted across releases (one large result or many small ones, closed together
  or one at a time), triggers one gen2 collection shortly after (pages are large arrays that nothing else would
  collect): non-compacting while results remain, aggressive (returning memory to the operating system) when none do.

Notes appended to the summary's messages:

| `truncated` | Note |
| --- | --- |
| `rowLimit` (or truncated cells) | "Results were truncated by display limits. Display limits do not stop script execution." |
| `queryBudget`, `globalBudget` | "Results were truncated because the result memory budget ({n} MB) is full. Execution continued; close other query results to free memory." |
| `systemMemory` | "Results were truncated because the computer is low on memory. Execution continued." |
| more than `maxResultSets` sets | "Only the first ten result sets are displayed. Display limits do not stop script execution." ("first {n}" for other limits) |
| column lists past the summary's 12 MiB | "{n} later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution." |

A cell whose typed read fails becomes NULL with the error flag; that column switches to its fallback reader and the
messages get "Column ‘{name}’ ({type}): some values could not be read and are shown as NULL."

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
```

A read or close must name the current generation and a result the renderer owns (from a query summary or event, at most
100,000 per generation), or it ends `RESULT_UNAVAILABLE`; at most 64 requests may be outstanding.

**Main → worker:** `backend { generation, status }` on every change, `page { rid, seq, body: ArrayBuffer }`,
`end { rid, ok, result | code, message }`, `query { queryId, event }`, and `memory { usedBytes, globalBytes }`.

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
flags 1 NULL, 2 truncated, 4 read error, 8 over the text budget), `peekWindow`, `prefetch`, `getCell` and `close`, plus
`onQueryEvent`, `onMemory` and `applySummary`. It forgets a result once it is released or its generation is gone
(handles keep reporting `released` or `lost`), and remembers at most 64 windows and 4,000,000 characters per result. A
worker that fails is recreated and reattached at most 3 times a minute; after that, results show "Results cannot be
displayed; reload the workbench."

**The PR6 results table** (`legacy.ts`) still shows at most 1,000 rows across the first ten result sets, 100,000 cells,
4,000,000 characters and 16,384 characters per cell (XML plans 2,097,152), reading them through `getWindow` (windows
sized from the set's bytes per row to fit half the worker's cache) and closing them afterwards. A failed read keeps the rows already read and adds "Some rows could not be loaded: {message}".

## Malformed input

| Side | Input | Handling |
| --- | --- | --- |
| main ← backend | Bad magic, kind or flags; a kind for the wrong direction; a second HELLO; a stream truncated at EOF; an id at or above the next one to be issued | **Fatal:** the process is killed and the generation ends (`protocol`), counting toward the breaker |
| main ← backend | First stdout byte `{` | Protocol 1 backend: `failed (incompatible)` |
| main ← backend | An oversized body (skipped); an undecodable RESPONSE or EVENT body; a bad envelope; an event failing `queryEventSchema`; a credit overrun; a sequence gap; DATA for a request that is not a stream; a frame for a settled id | **Contained:** that request or stream fails with `STREAM_PROTOCOL` and gets CANCEL reason 3. The 8th contained violation in a generation is fatal. |
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
- **Quitting** waits for the backend to stop (stdin end, 2 s, then kill) before the app exits, and for any generation a
  restart is still closing, so a backend that cannot act on EOF never outlives the app with its sessions and locks. While
  it waits the app has no window and releases the single-instance lock, so relaunching starts a new instance at once.
  Closing the last window starts no new backend unless the app keeps running (macOS).
- **Reconnect.** A lost connection stays in Object Explorer as "{server} — connection lost" with **Reconnect…** and
  **Remove**. Only Reconnect (prefilled, without the password) replaces it, moving its query tabs to the new
  connection; their first execution starts with "This query opened a new SQL session. The previous session ended when
  the SQL backend restarted, so its SET options, temporary tables, and open transaction no longer exist."

## Limits

| Item | Value | Enforced by |
| --- | --- | --- |
| Request body (main → backend) | 4 MiB; a 1,000,000-character script is at most 3,000,000 UTF-8 bytes | main before writing (`TOO_LARGE`); the backend skips larger bodies |
| Response body (backend → main) | 16 MiB | backend (`RESPONSE_TOO_LARGE`); main skips larger bodies |
| Event body | 256 KiB | backend |
| Control decoding | depth 16; 4,096 map entries; 1,048,576 array items; 128-byte keys; integers within ±(2⁵³ − 1) | both |
| Page | 1 – 4,096 rows and columns; sealed at 256 KiB or 4,096 rows; first page at 64 rows or 20 ms; idle seal 200 ms | backend; checked by the worker |
| Encoded row | 8 MiB; later cells become truncated prefixes | backend |
| Stored cells | text 65,535 characters; xml, json and showplan 2,097,152; vector 65,535; binary and CLR types 32,766 bytes | backend |
| Result sets kept per query | 1 – 1,000 (default 10) | zod and backend |
| Rows stored per query | 0 – 2,147,483,647 (0 = budget only) | zod and backend |
| Result budget | `clamp(available memory / 4, 256 MiB, 2 GiB)`; 50 % per query; none under high system memory load | backend |
| Messages | 1,000 messages / 1,000,000 characters; error text 16,384 characters | backend |
| Pending requests in main | 256 per generation plus 32 for control-lane methods; 32 MiB queued for stdin | main |
| Backend concurrency | 288 requests in flight; 8 metadata slots; 32 query sessions; 16 concurrent `results.read` | backend |
| Credit | 64 KiB – 16 MiB per grant (worker 4 MiB); 16 MiB outstanding per stream, 64 MiB per port; one page of overdraft | main and backend |
| Results port | 64 outstanding requests; 100 invalid messages close it; 10 opens a minute per page load | main |
| Results worker | 64 MiB / 512 cached pages (pending windows answer early past 64 MiB); windows of 4,096 rows, 262,144 cells, 4,000,000 characters | worker |
| PR6 results table | 1,000 rows, 100,000 cells, 4,000,000 characters, 16,384 per cell (plans 2,097,152) | renderer |
| Timers | HELLO 20 s; PING every 5 s; unresponsive after 15 s; stop grace 2 s; backstop deadline + 5 s; progress ≤ 10/s; messages every 100 ms | main and backend |
| Restarts | after 0 s, 1 s, 2 s; breaker at 3 unexpected losses in 120 s; reset after 300 s ready | main |
| Registries | 1,024 lost connection ids; 4,096 abandoned request ids; 100,000 owned results per generation; stderr 32 lines × 512 characters | main |

## Error codes and fixed sentences

Failures reach the renderer as `{ ok: false, error, code }`. Messages are complete sentences shown as they are.

| Origin | Codes |
| --- | --- |
| Backend | `INVALID_REQUEST`, `INVALID_PARAMS`, `METHOD_NOT_FOUND`, `BUSY`, `CANCELLED`, `TIMEOUT`, `SQL_ERROR`, `SMO_ERROR`, `BACKEND_ERROR`, `NOT_CONNECTED`, `NOT_FOUND`, `DUPLICATE_QUERY`, `SESSION_BUSY`, `SESSION_LOST`, `SESSION_CLOSED`, `SESSION_TARGET`, `SESSION_LIMIT`, `AUTH_UNSUPPORTED`, `INVALID_SCRIPT`, `TOO_LARGE`, `RESPONSE_TOO_LARGE`, `RESULT_NOT_FOUND`, `RESULT_RELEASED` |
| GOAWAY | `PROTOCOL_ERROR`, `PROTOCOL_UNSUPPORTED`, `BACKEND_CRASH` |
| Main | `BACKEND_LOST`, `BACKEND_UNAVAILABLE`, `CONNECTION_LOST`, `RESULT_UNAVAILABLE`, `TOO_MANY_REQUESTS`, `STREAM_PROTOCOL`, `PORT_CLOSED`, `TIMEOUT`; an unknown backend code becomes `BACKEND_ERROR` |
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
| `TOO_MANY_REQUESTS` | "Too many pending backend requests." |
| `STREAM_PROTOCOL` | "The SQL backend sent an invalid response. The request was cancelled." |
| `RESPONSE_TOO_LARGE` | "The backend result is too large to return (limit 16 MB)." |

| Surface | Text |
| --- | --- |
| Status bar | "Starting SQL backend…", "{runtime} · Ready", "SQL backend not responding…", "Restarting SQL backend…", "SQL backend unavailable" |
| Banner: not responding | "The SQL backend is not responding. You can keep waiting, or restart it; restarting closes all connections and rolls back uncommitted transactions." **Restart now** |
| Banner: unexpected restart | "The SQL backend stopped unexpectedly and was restarted. {n} connection(s) were lost and {m} running script(s) were stopped; nothing was re-run." **Reconnect…** **Dismiss** |
| Banner: manual restart | "The SQL backend was restarted. {n} connection(s) were closed." **Reconnect…** **Dismiss** |
| Banner: crash loop | "The SQL backend stopped repeatedly and was not restarted again." **Restart SQL Backend** **Copy details** |
| Banner: cannot start | Development: "Could not start the .NET backend. Install .NET 10 and run npm run backend:build." Packaged: "Could not start the SQL backend. Reinstall Varia SQL Manager." |
| Banner: different build | "The SQL backend is from a different build (protocol {x}, expected 2{; missing: method}). Run npm run backend:build, then restart." (packaged: "Reinstall Varia SQL Manager.") |
| Execute hint, lost connection | "This query's connection was lost when the SQL backend restarted. Reconnect to run queries." |
| Running placeholder | "Your query is running… {n} rows" |

**Copy details** lists the generation, status, the last loss and its reason, exit code and signal, uptime, losses in the
last 120 s, the protocol, runtime and OS, and the stderr lines described above.

## Display formats

The backend formats every non-binary value into the text SSMS 2022 shows (`CellFormat.cs`), so the renderer never
formats SQL types. Every sample is a case in `tests/fixtures/sql-display.json`, checked against `CellFormat` offline and
against SQL Server by the live type matrix. Reads use `CommandBehavior.SequentialAccess`, call `IsDBNull` first, and read
each column once, in order, with a reader chosen once per result set from the schema table.

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
| xml, the showplan column | the text as SqlClient serialises it, role `xml` / `plan`, up to 2,097,152 characters. Read once with `GetSqlXml` (linear; held only while the cell is read): `GetChars` on xml is quadratic in a large text node, and `GetXmlReader` misreads a value that starts with text | `abc`, `é<a b="1" />` |
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
- **Secrets.** Passwords exist only inside REQUEST bodies on the private pipe: never in arguments, environment,
  `BackendState`, the fake backend's call log, traces or stderr. Lost connections keep their options without the
  password.
- **Test seams** are honoured only when `VARIA_SMOKE_TEST=1` and the app is not packaged: `VARIA_TEST_BACKEND` (with an
  absolute `VARIA_TEST_NODE`), `VARIA_BACKEND_TEST_HOOKS`, `VARIA_RESULT_BUDGET_BYTES`, `VARIA_BACKEND_LIVENESS_MS`,
  `--varia-test-mode` (`window.__variaResults`) and `globalThis.__variaTest`. `VARIA_IPC_TRACE=1` (unpackaged only)
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
  `unresponsive`, and others) and a `workbench` mode for the Electron smoke tests, controlled through
  `VARIA_TEST_BACKEND_DIR` (`calls.jsonl`, `hold/<method>`, `allow/audits`, `crash-next`, `silent-<generation>`).
- **Real backend.** `tests/backend-sidecar.test.ts` drives the Release build over `BackendConnection`, including
  malformed frames, stdout purity and, with the test hooks, synthetic results, streams, cancellation and the budget.
  `scripts/backend-smoke.mjs` covers restarts, lost connections, the crash loop, the silent backend, a protocol 1
  backend, and UI responsiveness while a million stored rows are read.

## Benchmarks

```sh
npm run bench                                   # node harness: codecs, and main ↔ Release backend ↔ results worker
npm run bench:e2e                               # Electron, real backend with test hooks (add -- --live for SQL Server)
node scripts/check-bench.mjs [--enforce]        # compare with tests/bench/floors.json; markdown to $GITHUB_STEP_SUMMARY
```

Both harnesses need the Release backend and, for `bench:e2e`, the built app (`npm run check`). They write
`artifacts/bench/node.json` and `artifacts/bench/e2e.json`; they are not part of `npm run check`. The benchmarks only
measure (and check that every row and cell arrived); `check-bench.mjs --enforce` fails when a value is worse than its
floor. CI enforces floors on Linux (with live SQL Server); Windows and macOS report only.

- **W1** is a typical wide row: int, nvarchar(50), datetime2(7), decimal(18,2), uniqueidentifier, nvarchar(200) of 80
  characters, bit, and an int that is NULL in every fifth row (about 220 bytes encoded). **B1** is two nvarchar(max)
  values of about 4 KB. Both come from `debug.results.synthesize`, so the backend stores them as it would query rows.
- **The node pipeline** runs main's real classes: `BackendSupervisor` and `BackendConnection` over stdio to the Release
  backend, `ResultsPortHost` over a `MessageChannel`, and `ResultsWorkerCore` in a worker thread reading windows of
  every row with every cell decoded (four windows in flight).
- **The e2e run** reads every row through `window.__variaResults` in the built app (four windows in flight), watching
  the UI thread for long tasks and animation-frame gaps; `--live` stores a million W1-like rows from SQL Server with
  `maxRows: 0`.

| Metric | Target | Floor (Linux CI) | Measured, 4 CPUs | Measured, 2 CPUs |
| --- | --- | --- | --- | --- |
| Control encode + decode, 1 KiB map | ≥ 100,000 ops/s | ≥ 25,000 ops/s | 46,000 – 50,000 ops/s | 55,000 ops/s |
| Frame parse, 64 KiB chunks, mixed sizes | ≥ 1,000 MB/s | ≥ 250 MB/s | 2,800 – 4,100 MB/s | 3,900 MB/s |
| `decodePage` and the text of every cell, W1 page | ≥ 300 MB/s | ≥ 75 MB/s | 370 – 385 MB/s | 395 MB/s |
| main ↔ backend `system.health`, p50 / p99 | ≤ 0.3 / 2 ms | p50 ≤ 2 ms | 0.12 – 0.14 / 0.4 – 0.5 ms | 0.09 / 0.8 ms |
| 256 concurrent `system.health` | ≤ 150 ms | ≤ 1 s | 4 – 7 ms | 7 ms |
| W1, 500,000 rows, store → main → port → worker | ≥ 1,000,000 rows/s, ≥ 200 MB/s | ≥ 250,000 rows/s, ≥ 50 MB/s | 710,000 – 935,000 rows/s, 150 – 203 MB/s | 514,000 – 612,000 rows/s, 112 – 133 MB/s |
| B1 through the same path | ≥ 400 MB/s | ≥ 100 MB/s | 250 – 410 MB/s | 249 MB/s |
| Main event-loop delay during W1, p99 | ≤ 20 ms | ≤ 100 ms | 12 – 14 ms | 17 ms |
| Page bytes sent ÷ distinct page bytes, W1 | ≤ 1.05 | reported only | 1.29 | 1.29 |
| Budget charged ÷ page bytes | ≤ 1.15 | ≤ 1.5 | 1.00 | 1.00 |
| Renderer invoke → backend → renderer, p50 / p99 | ≤ 1 / 5 ms | p50 ≤ 5 ms | 0.4 / 1.2 – 1.6 ms | 0.4 / 2 ms |
| W1, 500,000 rows into the worker and UI windows | ≥ 500,000 rows/s, ≥ 100 MB/s | ≥ 100,000 rows/s, ≥ 20 MB/s | 240,000 – 303,000 rows/s, 52 – 66 MB/s | 200,000 rows/s, 44 MB/s |
| B1 into the worker | ≥ 200 MB/s | ≥ 40 MB/s | 90 – 143 MB/s | 90 MB/s |
| First 100-row window of a stored result | ≤ 50 ms | ≤ 250 ms | 17 – 21 ms | 20 ms |
| UI long tasks over 50 ms during W1 | 0 | ≤ 2 | 0 | 0 |
| Largest animation-frame gap during W1 | ≤ 50 ms | ≤ 300 ms | 17 – 33 ms | 133 ms |
| Live: 1,000,000 W1-like rows ingested and stored | ≥ 300,000 rows/s | ≥ 75,000 rows/s | 280,000 – 298,000 rows/s | 280,000 rows/s |
| Live: first 100-row window after `resultSet.opened` | ≤ 50 ms | ≤ 250 ms | 45 – 103 ms | 102 ms |

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
