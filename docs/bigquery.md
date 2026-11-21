# BigQuery

Varia connects to Google BigQuery beside SQL Server. This page describes how it works now: the Connect dialog, saved
connections, sign-in, identity pins, connect and disconnect, the pre-connect methods, errors, emulator mode and testing.
Query execution and Object Explorer's datasets come in later lanes (docs/bigquery-plan.md); until then a BigQuery server
shows in Object Explorer with nothing to expand (Search Objects and Object Explorer's status chips leave it out), and a
query tab can pick its default dataset but not run.

## Connect dialog

**Server type** (SQL Server or BigQuery) heads the Connection Properties. A new dialog opens on the type connected to
last (across both libraries; SQL Server when there is none). Switching keeps each type's fields, and the note under it
offers **Undo** back to the previous type. Choosing a history row switches to its type. BigQuery has no Connection String
tab, no Encrypt, TLS or SqlClient options and no Register server.

| Field | What it does |
| --- | --- |
| Account line | `bigquery.account` for the chosen sign-in, 250 ms after it changes; **Check again** retries. It names the account (and the impersonated service account) or why sign-in failed. |
| Authentication | gcloud credentials (ADC), Service account key file or Workload/workforce identity federation (below). Changing it forgets the picked file. |
| Key file | Service account key and federation only. **Browse…** opens main's file picker (`connections-pick-key-file`); the renderer gets an opaque reference and the file's name, never its path. |
| Project | The billing project, typed or picked: the combo and **Browse** (in the sources pane) list `bigquery.projects`, up to 10 pages (10,000 projects). |
| Location | Automatic (from the default dataset) or a BigQuery location. |
| Default dataset | Typed or picked from the project's datasets (`connections.databases`, below), loaded when the box is focused or with its button; a dataset in another location is noted. |
| Advanced… | A sub-dialog: Maximum bytes billed (MiB, GiB or TiB, binary), Impersonate service account, Extra projects (read-only projects Object Explorer and IntelliSense will list, at most 16, never the billing project), and Ask before running a query over the cost threshold (cleared by "Don't ask again"; Cost, below). |

**Test Connection** loads the datasets with the dialog's options (it proves sign-in and the project without creating a
job); **Connect** opens the connection through main's connection owner like SQL Server's (receipts, reuse, the target's
principal pin), with Custom Properties (name, colour, environment) and Auto reconnect as for SQL Server. Password fields
and Remember password do not exist for BigQuery: Varia keeps no BigQuery secret.

A federation configuration whose `credential_source` is a file (decision 49): when it is picked, the dialog asks **Use
this token file?**, naming the token file; a file source main cannot show as one full local path is refused. **Use It** records the confirmation (`connections-confirm-source`); main
refuses the configuration's sign-in until then, and fails closed where it cannot ask (a background reconnect). A changed
token path asks again.

## Saved connections

BigQuery entries live in `bigquery-connections.json` beside SQL Server's library: favourites, saved entries and the 30
most recent connects, each keyed by its settings, with environment labels and the cost-prompt choice (`costPrompt: false`,
[Cost](#cost)) per entry, written atomically and quarantined if unreadable. An entry with a key file keeps the file's path for main only; after a restart main reads the
saved connections when a reference is first needed (a reconnect at startup included) and maps it back to its file. A
target whose entry has left the history (pruned or removed) asks for the key file again. The file also keeps the newest 64 confirmed federation token files. The dialog's history
lists both engines by recency: a BigQuery row shows the project where SQL Server shows the server, then `BigQuery`, the
default dataset and the sign-in (with the key file's name). Object Explorer, tabs, the query bar and the status bar show
the project where SQL Server shows the server; the query tab's **Dataset** box lists the project's datasets with
`<no default dataset>`, and the status bar shows Project, Account and Dataset. Saved BigQuery targets reconnect at
startup with their pinned account, like SQL Server's.

## Packages

The backend uses Google's REST client, `Google.Cloud.BigQuery.V2` 3.12.0, which brings `Google.Apis.Auth`,
`Google.Apis.Bigquery.v2`, `Google.Api.Gax.Rest` and `Newtonsoft.Json`. Every client and credential takes its HTTP
client from `BigQueryEnvironment.Http`, so requests use the system proxy and certificate store, and the offline checks
replace it with a fake.

- **Licenses.** `backend/package-licenses.json` lists every package the backend resolves with the license its `.nuspec`
  declares (`node scripts/package-licenses.mjs` regenerates it after a restore). `tests/backend-licenses.test.ts` holds
  it to `packages.lock.json` and allows only MIT, Apache-2.0 and BSD-3-Clause, plus named exceptions (SqlClient's SNI).
  Google's libraries are Apache-2.0 and BSD-3-Clause.
- **Size.** The win-x64 self-contained ReadyToRun backend grows by 4.6 MB (1.9 MB compressed) with the REST client.
  Adding the Storage Read API and Arrow (`Google.Cloud.BigQuery.Storage.V1` 3.20.0 with gRPC, `Apache.Arrow` 23.0.0, for
  Storage Read) adds 5.4 MB more (2.2 MB compressed); `Apache.Arrow.Compression` 23.0.0 (Zstandard through
  `ZstdSharp.Port`, which brings K4os's LZ4) adds about 0.6 MB of assemblies.

## Authentication

| Mode (`authentication`) | Credential material main sends (`credential.source`) | What the backend accepts |
| --- | --- | --- |
| `gcloud` (the default) | ADC's order: the file `GOOGLE_APPLICATION_CREDENTIALS` names (`adc`), else gcloud's `application_default_credentials.json` under `CLOUDSDK_CONFIG` or the platform's gcloud folder (`adc`), else `metadata` | `authorized_user`, `service_account`, `external_account`, `external_account_authorized_user` or `impersonated_service_account`; `metadata` asks the metadata server, and none answering within 3 s is `AUTH_EXPIRED` with how to sign in |
| `serviceAccountKey` | The picked file (`file`) | `service_account` only |
| `externalAccount` | The picked file (`file`) | `external_account` or `external_account_authorized_user` |

Any mode may add `impersonateServiceAccount`: the backend signs in as above, then asks IAM Credentials for the service
account's token. Google's library impersonates only from a service account, a user, the metadata server or a federation
configuration that impersonates nothing itself, so a workforce user or a credential that already impersonates fails
`AUTH_KEY_FILE`, as does an `impersonated_service_account` file built on one.

- **Main reads the files** (`src/main/bigquery-credentials.ts`), except a federation file source (below). The renderer
  names a key or configuration file only by an opaque reference (`BigQueryKeyFiles`: the token main's picker returned,
  which a saved entry keeps), never a path. A picked file must be a regular `.json` file on a local disk (never a UNC share or device path);
  any credential file is at most 64 KiB and valid UTF-8. Its content travels only in a sensitive
  request (zeroed once written), and no message names its path or content.
- **Typed loads.** The backend loads each type with its own `CredentialFactory.FromJson<T>`, never the generic
  `GoogleCredential.FromJson`, and builds an impersonated file's source credential itself.
- **URL pins for every type.** `universe_domain` must be `googleapis.com`. `token_uri` must be Google's token endpoint;
  `token_url`, `token_info_url` and `revoke_url` Google's STS endpoints; the impersonation URL IAM Credentials'
  `generateAccessToken` for one service account; an impersonated file's `source_credentials` are checked the same way
  and may not impersonate again. Any other URL field must be https on a Google host, and an object or array Varia does
  not read is refused. Every field name must be Google's lower-case spelling and appear once at every depth, since the
  library's loads match names case-insensitively and keep the last. A refusal is `AUTH_KEY_FILE` naming the field, never
  its value.
- **Federation sources.** `credential_source` may be a fully qualified `file`, AWS (metadata URLs on `169.254.169.254`
  at their documented paths, `environment_id` `aws1`, and the exact regional verification URL, which is signed, never
  called; the IPv6 host `fd00:ec2::254` is refused because Google's library cannot load it) or Azure (the instance
  metadata token URL with only `api-version`, `resource`, `client_id`, `object_id` and `msi_res_id`, and only the
  `Metadata: True` header). `executable` and `certificate` sources are refused. The subject token's `format` is `text`
  or `json` with its field. Instance metadata requests (plain http, answering with credentials) bypass the system proxy, never follow a redirect and are capped at 64 KiB. Google's universe and the metadata token URL are set explicitly, so `GOOGLE_CLOUD_UNIVERSE_DOMAIN` and `GCE_METADATA_HOST` cannot move a request or a token to another host.
- **The backend reads file sources itself, again on every token exchange**, so projected Kubernetes and OIDC tokens
  rotate; it is the one credential file main does not read. The path comes only from a configuration main read and must
  be a full local path: on Windows a drive-letter path on a fixed or removable drive (no UNC share, network drive,
  device or NT path, and no link on the way that leads to one); elsewhere a path under a single `/` outside automounted folders (`/net`, macOS's `/Network`, and every autofs mount point the mount table lists; a home folder on an automounted NFS share is refused like a network drive), with links read before they are followed. The rules are
  judged on the file's canonical path (links, junctions and short names resolved): a file under Varia's user data,
  gcloud's folder, `~/.ssh` or `~/.aws`, the ADC file itself, anything under `/proc`, `/sys` or `/dev`, anything but a
  regular file (a FIFO is opened without waiting and refused), a file over 64 KiB, or a Google credential file (with or
  without a byte order mark) is refused, so its content never reaches Google's STS. A read that does not finish in
  5 seconds fails the exchange. No message names the path or the content.
- **Tokens** stay in backend memory. Messages carry Google's text on one line with access, refresh and JSON Web Tokens
  redacted.

## Identity pins

Each connection pins the principal Google verified at connect, as `ConnectionInfo.principalId` (`bigquery:` and the pin):

| Credential | Pin |
| --- | --- |
| Service account key | `serviceAccount:` and the key's `client_email` |
| User (gcloud) | `user:` and the email tokeninfo names for the access token (its `sub` without one) |
| Metadata server | `computeEngine:` and the metadata server's service account email |
| Federation, file or Azure | `external:` the audience and the subject token's subject (a JWT's `sub`, a SAML assertion's NameID; a token with neither is refused) |
| Federation, AWS | `aws:` the audience and the instance role (or the access key id when AWS's environment variables supply keys) |
| Workforce user (`external_account_authorized_user`) | `externalUser:` the audience and the username STS introspection names |
| Any, impersonating | `impersonated:` the service account and the base pin |

A pin longer than 247 characters, or not one visible line, is replaced by its SHA-256 fingerprint. Whenever a
connection's token changes (a refresh), the backend resolves the principal again before the token signs anything; a
different pin fails `AUTH_IDENTITY`, naming kinds only. A file source's subject is checked on every read the same way.

## Connect and disconnect

`connections.connect` with `provider: 'bigquery'` takes the BigQuery options (`src/shared/connections.ts`) and main's
`credential`. The backend signs in and pins the principal, then probes with a dry run of `SELECT 1` in the billing
project (free; it proves `bigquery.jobs.create`), labelled `varia_client: varia` like every job Varia creates. With a
default dataset and no location, `datasets.get` gives the connection's location. Connect has 40 s (12 s for a background
reconnect) inside main's deadline. The answer is a `ConnectionInfo`: the project as `server`, the dataset as `database`,
`BigQuery` as `serverVersion`, the account as `login`, the pin as `principalId` and `providerId: 'bigquery'`.

Main opens a BigQuery connect through `ConnectionOpenService`, as for SQL Server: it adds the credential, refuses
Remember password and credential references, pins the verified principal to the target (another account on a pinned
target is `identity-changed`, and an answer without a verifiable principal is refused), records the connect in BigQuery's
history and registers the handle's provider so methods for the other engine are refused before they reach it.

`connections.disconnect` releases the handle and its client. A SQL Server method for a BigQuery handle answers
`UNSUPPORTED_PROVIDER` (docs/ipc.md#providers).

## Pre-connect methods

The dialog's account line and project picker run before a connection exists. Both are sensitive, on the control lane,
with 30 s; the renderer sends the mode, key file reference and impersonation target, and main adds `credential`.

- `bigquery.account` signs in and answers `{ kind, account, impersonated? }`, creating no job.
- `bigquery.projects` answers one page of BigQuery's `projects.list` (up to 1,000, with `nextPageToken`), dropping ids
  that are not valid project ids and control characters in friendly names.

## Datasets

`connections.databases` with BigQuery's options (and main's credential) lists the billing project's datasets for the
dialog; `databases.list` does the same for a connected handle (the query tab's Dataset box). Both read every page of
`datasets.list` (a free REST call, no job) up to 10,000 datasets, sorted by name, each with its location; names
BigQuery's rule refuses are dropped, and a location that is not a location id is left out.

## Execution

`query.execute` on a BigQuery handle runs the editor's text as one query job (`SqlService.BigQueryExecution.cs`). It
takes an optional `dataset` (the query's default dataset; the connection's when absent) and ignores `database`. SQL
Server's options (stop on error, actual and live plans, client statistics) are refused with `UNSUPPORTED_PROVIDER`, in
main and in the backend, and `#legacySQL` is refused with `LEGACY_SQL` before any job. A BigQuery query tab sends its dataset (when it has one)
and leaves out SQL Server's options whatever the tab and Tools › Options hold.

- **One job, never two.** The backend sends `jobs.insert` with a client job id (`varia_` and 32 hex digits), GoogleSQL
  (`useLegacySql: false`), the default dataset, the connection's maximum bytes billed, the execution timeout as
  `jobTimeoutMs` (BigQuery stops the job itself) and the `varia_client` label. After a network failure or a 5xx it asks
  `jobs.get` for that id and sends the insert again, under the same id, only when no such job exists; a 409 means the
  job exists and is read instead.
- **Polling and paging.** `jobs.getQueryResults` long-polls until the job is complete; that answer carries the first
  page (500 rows), and later pages ask for about 250,000 cells (500 to 10,000 rows). Times come as epoch microseconds.
  Reads retry transport failures, 429 and 5xx with backoff. A page larger than 64 MiB is refused rather than buffered.
- **Rows in memory.** `BigQueryColumnPlan` decodes each REST row straight into the result store's pages, as SQL
  Server's reader does: the same row limit, result budget (each page is charged while its rows are decoded), cell caps
  (text 65,535 characters, documents 2 MiB, bytes 32,766) and truncation notes. Rows past a limit stay in BigQuery and
  are counted from its `totalRows`. More than 4,096 columns keeps the first 4,096 with a note. A value that cannot be read
  is NULL with the read-error flag and one message for its column. Discard results reads no rows.
- **Types.** INT64, FLOAT64 (shortest round-trip), NUMERIC and BIGNUMERIC (canonical decimal text), BOOL, STRING, BYTES
  (binary), DATE (`2026-11-15`), TIME and DATETIME (`2026-11-15T09:30:00.5`, the fraction without trailing zeros),
  INTERVAL in canonical form (`1-2 3 4:05:06.5`), TIMESTAMP as `2026-11-15 09:30:00.000000 UTC`,
  RANGE, GEOGRAPHY (WKT), and JSON, STRUCT and ARRAY as compact JSON documents. Column types read as GoogleSQL writes them
  (`ARRAY<STRUCT<a INT64>>`, `NUMERIC(10, 2)`), from REST's legacy names too, and each sorts by its kind.
- **Summary.** Messages name the job (`project:LOCATION.job_id`), the rows (`(N rows affected)`, DML's affected rows),
  a DDL statement's completion, and the job's statistics: bytes processed and billed with their price, slot time and
  cache hit. The summary's `job` carries the same figures, and the Results status shows the bytes processed beside the
  row count ("1.24 GiB processed · < $0.01"). Each job's start and end also go to the renderer as a `query.job` event
  (docs/ipc.md, Query events).
- **Error positions.** BigQuery's `[line:column]` positions are the submitted text's; the backend maps them to the
  editor's, adding a selection's first line and, on that line, its first column (`startColumn`).
- **Stop and the timeout.** Stop ends the request with status `cancelled` and sends `jobs.cancel` (best-effort: BigQuery
  may still bill work done before the job stopped); the execution timeout does the same. A tab runs one query at a time
  (`SESSION_BUSY`).

### Scripts

A multi-statement script runs as one parent job whose statements are child jobs. Between polls (every 2 s) the backend
lists the parent's new children (`jobs.list` with `parentJobId`, newest first, so paging stops at the first child it has
read) and reads each finished one in statement order: a SELECT's rows become the next result set, a DML statement's
affected rows a `(N rows affected)` line, any other statement its completion sentence, and "The script completed." ends
it. Early results show while the script runs. A listing that fails between polls stops the early reads (`jobs.list`
needs `bigquery.jobs.list`, which the Job User role lacks); a final listing that fails shows only the last statement's
rows and says so. A failing statement names its editor position and how many statements before it ran and were billed.

### Sessions

Each query tab has its own BigQuery session, so temp tables, variables and transactions carry from one Execute to the
next. The tab's first job creates it (`createSession`); later jobs carry its id (`session_id`), which never leaves the
backend. Emulator mode has no sessions. A session runs one job at a time: a job Varia stopped, or lost track of after a
network failure, must reach DONE before the next one runs, and Messages says the tab is waiting for it. A job BigQuery
refused, or whose request never left the machine, holds nothing; nor does one cut off in flight that jobs.get never finds.

- **Location.** A session lives in one location. A tab's first job runs in its dataset's location when the connection's
  location is Automatic (`datasets.get`, cached), else the connection's, where every session then stays. On an Automatic
  connection, choosing a dataset in another location (or the same one again) asks "Switch this tab to EU?": Switch ends the session (asking first about a running query and an open transaction, as a
  close does) and the next Execute starts one in the new location; Don't Switch keeps the dataset and session. A query
  sent with such a dataset anyway is refused with `LOCATION_MISMATCH`. Temp tables in a session are billed as storage
  until the session ends.
- **Transactions.** The backend tracks the session's transaction from the statement types of its jobs, top-level and
  child: `BEGIN TRANSACTION` opens it, a successful `COMMIT` or `ROLLBACK` closes it, and a statement failing inside it
  makes it unknown (BigQuery names no reason, so message text is never read for this), as does a script whose children
  could not all be listed or a finished job's statements could not all be read. `query.session.state` answers from this, with no request to BigQuery: open is
  `{ transactionCount: 1, checked: true }`, unknown or a stopped job not yet DONE is `checked: false`, and a running query
  answers `SESSION_BUSY`.
- **Closing.** Close, Change Connection, Disconnect and quitting ask Commit or Roll Back for an open or unchecked
  transaction as they do for SQL Server, with BigQuery's own "not checked" note. Commit runs `COMMIT TRANSACTION` in the
  session; every close then ends the session with `CALL BQ.ABORT_SESSION(@session_id)` outside it, which rolls back
  what is still open. A close never aborts a session while one of its jobs runs: a commit or rollback answers
  `JOB_RUNNING` and the tab stays (a plain close stops the query first, as SQL Server's does). A job Varia stopped is
  waited for (20 s, 25 s for a commit) so the abort never races it.
- **Commit outcomes.** A commit BigQuery refuses keeps the tab on a session known to be in a transaction. On an unchecked
  session the refusal may only mean nothing was open, so the session is ended with the note `commitNotApplied`, except at
  quit, where the window stays open. A refusal BigQuery may lift (`backendError`, `rateLimitExceeded`) keeps the tab, and
  so does a commit whose request never left the machine (`CONNECTION_LOST`); closing again retries. A COMMIT job BigQuery
  stopped for its timeout is a refusal (`SQL_ERROR`); `TIMEOUT` is only main's deadline, whose outcome is unknown. A commit whose
  outcome is unknown (no answer within 25 s, or main's 60 s deadline) closes with `outcomeUnknown` and its job id: the
  session is aborted only once that COMMIT is DONE, or not found after 2 minutes, within 10 minutes and even after
  Disconnect; past that it is left to expire.
- **Notes.** A close answers a note when something needs saying: `commitNotApplied`, `committedBeforeCancel` (a stopped
  script had already committed), `outcomeUnknown`, `abortFailed` (the session could not be ended, so its transaction stays
  open until it expires and its temp tables are billed meanwhile; it outranks, and states, the note it would have carried)
  or `sessionExpired`. A note whose tab stays open, because it was edited during the close or a later tab stopped a quit,
  still shows in its Messages. It shows in the tab's Messages
  when the tab stays, else as a notification; quit stops for `outcomeUnknown`, `committedBeforeCancel` and
  `abortFailed` so they are read, and quitting again proceeds.
- **Expiry.** BigQuery ends a session after 24 hours idle or 7 days. A refusal counts as expiry only when its message names
  the session or opens with one, never an error about a column or table called session. A query refused for an expired session runs once more
  in a new one (the refused job ran nothing), and Messages says its temp tables, variables and any open transaction are
  gone. Closing an expired session succeeds at once, with `sessionExpired` when a transaction was tracked; a commit
  answers `SESSION_LOST`, saying nothing was committed.

### Storage Read

A large result is read through the BigQuery Storage Read API (Arrow over gRPC) into the same result set, budget and
limits as REST's (`SqlService.BigQueryStorageRead.cs`, `ArrowColumnPlan`). REST and Arrow write identical text for every
type.

- **When.** After the first page: the rest of the rows remain, the job is a single SELECT (a script's rows come through
  REST) and the rows the row limit keeps are estimated at 20 MB or more (the destination table's bytes per row, else the
  first page's). The first page is then dropped and every row read from the job's temporary destination table. Reads
  of temporary tables are free (Google's pricing page), so there is no setting for it.
- **Streams.** The backend's own GoogleSQL scanner (`GoogleSqlScanner`, which skips comments, strings and nested
  queries) decides the order: a top-level `ORDER BY` (or pipe syntax's `GROUP BY k DESC`) reads one stream in order;
  anything else asks for up to four, appended as their batches come. When unsure it reads one stream, which is only
  slower. Each stream is read on its own task; each batch is charged to the query's budget (twice its size) before it
  is queued, and a compressed batch's decoded buffers are charged too while its rows are stored (a refusal stops the
  read at the budget), at most two batches are charged but not yet stored (so the budget holds as much as REST's; each other stream
  holds at most the one batch it received while it waits), and one reader
  appends rows, so the store keeps one writer. A stream that fails transiently is read again from its offset; one that
  fails for good fails the query at once, with REST's error (an expired sign-in is `AUTH_EXPIRED`).
- **Compression.** The session asks for Zstandard buffer compression: in the offline benchmark it sends a fifth to two
  fifths of the uncompressed bytes for 10 to 40% more decoding time, against LZ4's 55% for up to 20%
  (Throughput below). The reader also reads LZ4 and uncompressed batches, which an endpoint that ignores the option
  sends.
- **Fallback.** When a session cannot be opened, REST reads the result and the Messages tab says why once per
  connection, starting "Large results are read through the BigQuery API, which is slower:": the Storage API is disabled
  in the project or the credential lacks `bigquery.readsessions.create` (the connection stops asking), Google could not
  be reached (a proxy or firewall may block `bigquerystorage.googleapis.com` over HTTP/2; the connection reads through
  REST for ten minutes before trying again), or Google refused the session or sent columns that are not the result's
  (asked again on the next query). Any other failure while deciding also leaves the result to REST. A stream that fails after reading has begun
  fails the query (`CONNECTION_LOST` or `BACKEND_ERROR`), as a REST page would.
- **Proxy.** The gRPC channel uses the system proxy with HTTP CONNECT, like REST: on Windows and macOS the system's
  settings, on Linux `HTTPS_PROXY`/`ALL_PROXY` and `NO_PROXY`. The proxy must pass HTTP/2 through.

### Residence

A BigQuery result can be far larger than the memory budget, and its rows already sit in the job's destination table,
which is free to read. So a result is either **in memory**, as SQL Server's are, or **windowed in BigQuery**: the
backend keeps only the blocks the grid is showing, reads the rest as you scroll, and the caption says "windowed in
BigQuery" (`RemoteResult.cs`, `SqlService.BigQueryResidence.cs`; the protocol is docs/ipc.md's Remote results).

- **Setting.** Options › Query Results › BigQuery › Results: **Result residence** (`queryResults.bigQuery.residence`):
  Automatically, by size (the default), Always in memory (the old behaviour: the budget truncates) or Always windowed in
  BigQuery; and **Window cache** (`queryResults.bigQuery.windowCacheMiB`, 16 – 4,096 MiB, default 64), the blocks each
  windowed result keeps. Each query takes them as it starts.
- **Deciding.** After the first page and before the grid opens: a result stays in memory when the rows arrived whole,
  under Always in memory, when its destination table cannot be read, or when its rows (the first page's measured cost
  per row, times the total) fit half of what the query may still take from the budget. Otherwise it is windowed, and the
  first page becomes its first block. A windowed result counts at most 2,147,483,647 rows (the grid's 32-bit indexes);
  Messages says so when BigQuery holds more.
- **Misestimate.** When the budget refuses an automatic in-memory result part way, it switches to windowed instead of
  truncating: its pages are freed, the grid keeps its place and drops its selection, and a screen reader hears that the
  result is now windowed.
- **Blocks.** About 4 MiB of measured rows each (256 – 16,384 rows), read with `tabledata.list` from the destination
  table, at most two at a time per result and four per connection, backing off on rate limits. The cache keeps the
  most recently used blocks within the window cache, reserving each block from the result budget before it fetches, and
  shows as Window cache in the Memory panel. Each grid on the result reads one block ahead either side, and one more the
  way it is scrolling; a jump drops reads the grid no longer needs. A read waits up to 20 s for its blocks, then the
  grid shows the rows it has and asks again.
- **Load into memory.** `results.remoteQuery` kind `load` reads the whole table into memory under the budget (REST, or
  Storage Read when it qualifies), so the in-memory features work on it. A refusal part way, a failure or Stop leaves the
  result windowed, whole. The button that runs it comes in a later update.
- **What waits.** Filters, sorts, search, profiles, distinct values, pivots, row identities, comparisons, Copy and Save
  of a windowed result answer "This result is windowed in BigQuery" (`REMOTE_RESULT`) for now; later lanes run them in
  BigQuery. A destination table lasts about 24 hours: once it has expired, rows not cached answer `REMOTE_EXPIRED`.

### Cost

Bytes are written in binary units, as Google bills (`1.24 GiB`), and priced at the on-demand rate of $6.25 per TiB
beside them, "< $0.01" below a cent. The price is an estimate: projects with capacity reservations do not pay per byte.
`BigQueryCost` (C#) and `src/shared/bigquery/cost.ts` write the same text, pinned by `tests/fixtures/bigquery/cost.json`.
Query Execution › BigQuery › Cost's **Show cost as: Bytes only** leaves the dollars out everywhere (`prices: false` for
Messages).

- **The estimate.** `bigquery.dryRun` (free) answers the bytes a query would process. A query tab shows it in a chip
  beside Execute ("≈ 1.24 GiB · < $0.01"): neutral, amber above the cost-prompt threshold (its tooltip says whether
  Execute asks on this connection), and after a run what the job processed and cost, unless the text changed while it
  ran. Its tooltip says the estimate is free and on demand, and why it may be low.
- **Diagnostics.** After a 1 s pause in editing, a dry run (one in flight per tab; the latest text wins) marks the error
  BigQuery reports at its `[line:column]` (owner `varia.googlesql.dryRun`, so Alt+F8 reaches it) and updates the chip; the
  status bar reads "BigQuery: 1 error" or "BigQuery: no issues". Executing a selection marks its error where the
  selection puts it in the document. Nothing dry-runs after a restore, a provider switch, a connection or dataset change,
  or once the setting is off, until the user edits or executes (decision 44): an edit's dry run queued behind one in
  flight is dropped too, as is one Execute makes redundant. A table or dataset that does not exist is the query's
  error (`SQL_ERROR` with Google's text), a dataset in another location is `LOCATION_MISMATCH` as Execute says, a missing
  project stays `NOT_FOUND`, and a refused table keeps Google's text, since connecting already proved the account can
  create jobs. Text Editor › GoogleSQL › **Check queries with a dry run
  while editing** turns it off. A dry run sends the text to Google (docs/architecture.md).
- **Before Execute** the diagnostics estimate is reused when it is for the same text and dataset; otherwise Execute dry-runs
  first, and a pending diagnostics run is dropped. Varia asks in only two cases (decision 22), each opening with focus on
  Cancel as an alert dialog with a **Cost settings…** link:
  - **Above the threshold** (default 10 GiB): "This query will process 1.41 TiB (about $8.81 on demand), more than the
    10.00 GiB threshold. Run it?", with Run, Cancel and **Don't ask again for** the connection's name. That choice is
    kept on the saved entry as `costPrompt: false` (written through main's `varia:bigquery-cost-prompt`), so reconnects
    and restarts keep it; the connection's Advanced Properties › Cost › **Ask before running a query over the cost
    threshold** shows the saved choice and turns it back on. The Connect form names a choice only when that box is
    changed, so a remembered connection never undoes a later Don't ask again, and entries with the same settings share
    one choice (a connect that names one takes effect at once). If the choice cannot be saved, it holds for the session.
    It is a preference, not part of which entry the connection is or of its target.
  - **An incomplete estimate**, once per tab: a script (estimated only up to its first DDL or control statement),
    a 0-byte estimate for a query that reads tables (right for an empty table or skipped partitions, but external and
    row-level-security tables also report 0 bytes before they run), or an estimate BigQuery marks `LOWER_BOUND` or
    `UNKNOWN` (DDL that reads no table, such as DROP or TRUNCATE, never counts as 0-byte; DML and CREATE TABLE AS SELECT
    do). **Don't warn me about incomplete estimates
    again** clears `queryExecution.bigQuery.incompleteEstimateWarning`.

  One prompt shows at a time: another tab's waits its turn, so an answer always goes to the query it was shown for, and
  one that the answer before it made moot (Don't ask again) is not shown; the incomplete-estimate warning it was
  hiding still asks.

  A dry run that fails (the network, a permission) does not block: the query runs and reports its own error. Cancel,
  closing the tab or disconnecting while the estimate is worked out or a prompt is open or waiting stops the run at once,
  closes the prompt and sends nothing; its Don't ask again is not kept. An edit with the diagnostics setting off clears
  the chip and the marker for the old text. Emulator mode's faked estimates never ask.
- **The cap** is the hard guard: Cost's **Maximum bytes billed per query** (0, none, by default) goes out as the job's
  `maximumBytesBilled` when the connection's Advanced Properties set none; the connection's own cap wins. BigQuery fails a
  job past it at no charge (`COST_CAP`, which names the cap, in bytes alone under Bytes only).

## Errors

| Code | When | Text and recovery |
| --- | --- | --- |
| `AUTH_EXPIRED` | A refused refresh (`invalid_grant`) of a user sign-in, HTTP 401, or no credentials at all | "Your Google sign-in has expired." or "No Google credentials were found.", with `gcloud auth application-default login` |
| `AUTH_KEY_FILE` | A key or configuration file Varia cannot read or use, a refused shape, a deleted key (`invalid_grant` for a service account), a federated token Google's STS refuses (`invalid_grant` in federation mode), an unreadable subject token | Names the rule or field; choose the file again |
| `AUTH_IDENTITY` | The credential now signs in as another principal | Reconnect to use the new account |
| `PERMISSION_DENIED` | `accessDenied` or HTTP 403 | Names the missing permission (`bigquery.jobs.create` for connect) and the project |
| `API_DISABLED` | `accessNotConfigured`, `SERVICE_DISABLED` | Enable the BigQuery API in the Google Cloud console |
| `BILLING_DISABLED` | `billingNotEnabled` | Explains the sandbox limits |
| `QUOTA` | `quotaExceeded`, `rateLimitExceeded`, HTTP 429 | Which kind, with Google's text |
| `LEGACY_SQL` | `#legacySQL` before any statement | "Varia runs GoogleSQL only." |
| `NOT_FOUND` | `notFound`, HTTP 404 | Google's text, and to check the project id |
| `BACKEND_ERROR` | HTTP 5xx, `backendError`, `internalError` | Try again |
| `CONNECTION_LOST` | Google cannot be reached | Check the network connection and proxy settings |
| `TIMEOUT` | Connect's or a pre-connect method's budget passed, or a job BigQuery stopped at its timeout | Try again |
| `SQL_ERROR` | `invalidQuery`, or a job error with no other row | BigQuery's text, with its line and column |
| `LOCATION_MISMATCH` | A query's dataset is in another location (`notFound`, then `datasets.get` says where) | Names both locations |
| `RESULT_TOO_LARGE` | `responseTooLarge` | Over BigQuery's 10 GB result limit: filter or aggregate |
| `COST_CAP` | `bytesBilledLimitExceeded` | Names the cap the job carried (the connection's own, else Options') and Google's figure, in bytes alone under Bytes only; raise the cap or read less |
| `CANCELLED` | `stopped` | The job was cancelled |

## Emulator mode

`VARIA_TEST_BIGQUERY_ENDPOINT` points the backend at a BigQuery emulator. Main passes it only to unpackaged backends
and only as a loopback http address with no path (`bigQueryEmulatorEndpoint`); the backend checks it again. In emulator
mode main sends only anonymous material, the backend signs nothing, skips the connect probe, and fakes estimates.

The emulator (`ghcr.io/goccy/bigquery-emulator` 0.8.1) differs from BigQuery in ways the checks rely on: it answers dry
runs with HTTP 500, names projects in `projects.list` only by `id`, gives datasets no location, answers `tabledata.list`
in one page whatever `maxResults` asks, finishes jobs synchronously, and reports `INT64` where BigQuery says `INTEGER`.
It also refuses `jobTimeoutMs` sent as a JSON number, answers a repeated job id with 400 rather than 409, reports query
errors (syntax errors included) as `jobInternalError`, and reports no bytes statistics.

Storage Read against the emulator needs its gRPC port: `VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT` (a loopback http address,
honoured only with `VARIA_TEST_BIGQUERY_ENDPOINT`; main does not forward it, so the app reads the emulator through REST).
The emulator serves one stream per session, sends each batch as a whole Arrow stream (schema first), fails on DATETIME
and TIME columns, writes BYTES base64-encoded twice and exits on ARRAY columns; the offline golden check covers those.

## Testing

- **Offline.** `BigQueryChecks` and `BigQueryCredentialChecks` (in the offline .NET run; alone with
  `-- --bigquery-checks`) drive connect, disconnect and the pre-connect methods through `SqlService.DispatchAsync`
  against `BigQueryFake`, an HTTP handler injected through `BigQueryEnvironment.Http` that answers Google's endpoints
  from `backend/Varia.Backend.Tests/Fixtures/BigQuery` (hand-written from Google's documented shapes) and fails any
  request no route answers. They cover every mode's sign-in and pin, every error row, the accepted and refused
  credential shapes, emulator mode and the dataset lists. `BigQueryExecutionChecks` drives `query.execute` against a
  scripted BigQuery: the insert's body and job id, polling, paging, every type, the row limit, budget and cell caps, read
  errors, each error row, the lookup after a network failure and the 409 path, statistics and cost text. Its Storage
  Read part runs `BigQueryStorageFake` (Arrow batches through an in-process `IBigQueryStorageRead`): a golden of every
  type read through REST and Arrow to identical cells, the scanner, the session's request and thresholds, each fallback,
  the row limit and budget, resume from an offset, failures, Stop, and a local proxy that must receive the channel's
  CONNECT. Its Residence part covers the decision and both settings, the block cache (sizes, LRU, budget, lanes,
  read-ahead per viewer, a jump, waits, expiry, rate limits), every reader's `REMOTE_RESULT`, the switch to windowed on
  a misestimate through REST and Arrow, and Load into memory with its refusal and Stop. `tests/bigquery-remote-results.test.ts`,
  `tests/results-port.test.ts` and `tests/result-client.test.ts` cover main's and the renderer's side.
  `tests/bigquery-credentials.test.ts`, `tests/bigquery-connection-store.test.ts` and
  `tests/bigquery-connection-open.test.ts` cover main's side; `tests/bigquery-connect-form.test.ts`,
  `tests/bigquery-connect-dialog.test.ts` and `tests/bigquery-workbench.test.ts` the dialog and the workbench;
  `tests/bigquery-execute.test.ts` and `tests/bigquery-cost.test.ts` execution's contracts and cost text. The dry-run
  checks in `BigQueryChecks` cover `bigquery.dryRun` (the body, each incomplete reason, a refused query's `[line:column]`,
  the limits); `tests/bigquery-dry-run.test.ts` the cost rules, the prompts, the chip and the diagnostics loop, and
  `tests/queries.test.ts` Execute's cost gate. The emulator does not dry-run, so no live check covers it.
- **Emulator.** `-- --bigquery-emulator-live` with `VARIA_TEST_BIGQUERY_ENDPOINT` runs emulator mode end to end and the
  REST calls later lanes build on (client job ids, result and table paging, scripts, parameters, cancel, metadata), and
  `query.execute` end to end (every type, paging, the row limit, a script on the default dataset, DML, a failure).
  With `VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT` (the emulator's port 9060) it also reads results through Storage Read and
  compares them with REST's. CI runs it in live group 1 with both ports (docs/ci.md). `scripts/connections-smoke.mjs` drives the Connect dialog's BigQuery path
  against it when the variable is set (CI's Linux smoke shards set it; elsewhere that phase skips). Locally, start the emulator with Docker or Podman:

  ```bash
  docker run -d --name varia-bigquery -p 9050:9050 ghcr.io/goccy/bigquery-emulator@sha256:f4e428d265a93dc5ce36c294e1c584c7c9b384117d47ab8ddbb63d8d50b7f393 --project=varia-emulator --dataset=varia_fixture
  ```

  Add `-p 9060:9060` for Storage Read. On Windows use `http://127.0.0.1:9050` (`localhost` may resolve to IPv6 first).
- **Throughput.** `-- --bigquery-read-bench [--rows N] [--runs N]` times `query.execute` reading the same rows through
  REST and through Storage Read (four streams and one; uncompressed, LZ4 and Zstandard) against the offline fakes, so
  it measures decoding and storing, not the network or the fakes (the REST fake serializes each page once, and the
  forced collection one case's release schedules runs before the next case is timed), and prints the Arrow bytes each sent. It is run by hand, prints
  medians and has no floors. On a 2026 desktop, 500,000 rows:

  | Table | REST | Arrow | Arrow, LZ4 | Arrow, Zstandard |
  | --- | --- | --- | --- | --- |
  | numbers (INT64 counter, short strings) | 2.9 M rows/s | 9.2 M rows/s, 11.0 MB | 7.7 M, 6.1 MB | 6.6 M, 2.2 MB |
  | mixed (ids, amounts, countries, emails, text, flags) | 1.0 M rows/s | 2.5 M rows/s, 45.7 MB | 2.5 M, 26.1 MB | 2.3 M, 17.5 MB |

  Downloading and decoding overlap, so a read takes about the longer of the two: at 100 Mbit/s the mixed table takes
  about 3.7 s uncompressed and 1.4 s with Zstandard; at 1 Gbit/s about 0.4 s uncompressed and 0.2 s with Zstandard, where
  decoding bounds it.
- **Never a real project.** No check contacts Google Cloud. What only a real project can prove (tokeninfo and STS
  answers, Google's exact error bodies, bytes billed and slot statistics, a 409 on a repeated job id, whether a script's
  cap applies per statement) stays on the hand-written fixtures until the owner runs a check against one.
