# BigQuery

Varia connects to Google BigQuery beside SQL Server. This page describes how it works now: the Connect dialog, saved
connections, sign-in, identity pins, connect and disconnect, the pre-connect methods, execution, Object Explorer, errors,
emulator mode and testing. Search Objects indexes BigQuery connections too ([Search Objects › BigQuery](object-search.md#bigquery));
Object Explorer's status chips leave BigQuery out until a later lane (docs/bigquery-plan.md).

## Connect dialog

**Server type** (SQL Server or BigQuery) sits above the details tabs on the right pane. A new dialog opens on the type connected to
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
| Advanced tab | Inline properties with a modified-count badge: Maximum bytes billed (MiB, GiB or TiB, binary), Impersonate service account, Extra projects (read-only projects Object Explorer and IntelliSense will list, at most 16, never the billing project), and Ask before running a query over the cost threshold (cleared by "Don't ask again"; Cost, below). |

**Test Connection** loads the datasets with the dialog's options (it proves sign-in and the project without creating a
job); **Connect** opens the connection through main's connection owner like SQL Server's (receipts, reuse, the target's
principal pin), with Labels & Custom Properties (name, colour, environment) and Auto reconnect as for SQL Server. Password fields
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

`connections.disconnect` releases the handle and its client. A windowed result stays open with the blocks it has cached
(still charged until it is closed); reading a block it lacks answers `NOT_CONNECTED`. A SQL Server method for a BigQuery handle answers
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
  are counted from its `totalRows`; a result too large for the budget may instead stay in BigQuery
  ([Residence](#residence)). More than 4,096 columns keeps the first 4,096 with a note. A value that cannot be read
  is NULL with the read-error flag and one message for its column. Discard results reads no rows.
- **Types.** INT64, FLOAT64 (shortest round-trip), NUMERIC and BIGNUMERIC (canonical decimal text), BOOL, STRING, BYTES
  (binary), DATE (`2026-11-15`), TIME and DATETIME (`2026-11-15T09:30:00.5`, the fraction without trailing zeros),
  INTERVAL in canonical form (`1-2 3 4:05:06.5`), TIMESTAMP as `2026-11-15 09:30:00.000000 UTC`,
  RANGE, GEOGRAPHY (WKT), and JSON, STRUCT and ARRAY as compact JSON documents. Column types read as GoogleSQL writes them
  (`ARRAY<STRUCT<a INT64>>`, `NUMERIC(10, 2)`), from REST's legacy names too, and each sorts by its kind. Timestamp sorting,
  grouping, profile distinct counts and profile minimum and maximum values use the UTC instant down to its microsecond.
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

In-memory BOOL columns order false before true when they sort, filter between values, pivot (groups, Min and Max) and profile. Saving as JSON writes Boolean values; CSV and tab-delimited text keep the displayed words.

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
  transaction as they do for SQL Server, with BigQuery's own "not checked" note; a tab holding a job is asked about the
  job instead ([Re-attaching to jobs](#re-attaching-to-jobs)). Commit runs `COMMIT TRANSACTION` in the
  session; every close then ends the session with `CALL BQ.ABORT_SESSION(@session_id)` outside it, which rolls back
  what is still open. A close never aborts a session while one of its jobs runs or is left running: a commit or rollback
  answers `JOB_RUNNING` and the tab stays, and a plain close leaves the job and its session (the workbench cancels the
  job first when you choose Cancel the job). A job Varia stopped is waited for (20 s, 25 s for a commit) so the
  abort never races it.
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

### Re-attaching to jobs

Stopping or restarting the backend never cancels a BigQuery job; only Stop and a close that asks to cancel the job do. A
Stop pressed while a restart waits for idle sessions to end reaches the backend being ended, if that backend holds the run. The backend and main:

- **Job keys and records.** A BigQuery request may carry its tab's `jobKey` (a uuid). Main records each request's
  top-level job from its `query.job` event in `WorkbenchSession/jobs.json`: job id, project, location, state, whether it
  is left running (an auxiliary flag is reserved and always false), and the session's transaction state as it started. No SQL text and no secrets. The file
  has a strict schema, holds 64 records per key and 1,024 in all (the oldest finished go first; running jobs' records go
  only past 1,024 of them, newest first), is written atomically on every change and quarantined when unreadable, and
  records expire 24 hours after main first recorded their job. A finished job's records go once its summary reached the tab, and so do a stopped or timed-out request's; a job still running when the
  backend was lost, or left running, keeps its record. A job re-attached under another key moves to it. A re-attach its identity check refused (`AUTH_IDENTITY` before the job was reported) drops that
  job's record, which would otherwise come back at every restore.
- **`query.attach`** re-attaches a tab to a job by reference (`jobId`, `project`, `location?`), as a query: it first checks
  that the connection's principal created the job (`jobs.get`, then a free `jobs.list` over its creation time must name
  it; `AUTH_IDENTITY` otherwise, and the job is left alone). The listing needs `bigquery.jobs.list` (BigQuery User has
  it, Job User does not): without it a re-attach answers `PERMISSION_DENIED` naming the permission and leaves the job
  running, except to a job the tab's session inserted in this backend. A running job shows "Re-attached to BigQuery job … started N
  ago" and Stop cancels it (a Stop during the identity check cancels it once the check passes; when the check or the
  cancel fails, the run says the job may still be running, and so does the closing tab's note when the re-attach adopts
  the job's session; Leave it running during the check leaves the job alone); a finished one reads its result table (free) by the usual residence rule; a script's children
  are listed again. `adoptSession` takes over the session the job ran in, with the record's transaction state. Results
  gone answer `REMOTE_EXPIRED`. `detached` only holds the session's queue until the job is DONE and reads no results. One
  attachment per job: a second `query.attach` takes over and the first answers `superseded`.
- **Leave it running.** `query.cancel` with `detach` makes a running request answer `detached`; the job holds the tab's
  session, the backend polls it with backoff until DONE (`query.session.state` answers `job: 'running'` meanwhile), and the
  next Execute waits for it. A network failure mid-job holds the job the same way, as does any other failure of the run
  while its job still runs (a rate-limited poll, say): the tab keeps it, Messages says so, and closing the tab asks.
- **Idle sessions end with their connection.** A session holding no running or left-running job is ended
  (`ABORT_SESSION`) on Disconnect (`connections.disconnect` answers `failedAborts`) and before every backend stop main makes but
  one of a backend that is not responding (`bigquery.endIdleSessions`, 10 s), which leaves a kept tab's finished-job session with an open or unknown transaction
  (`keepJobKeys`). A session close or state read during that wait, and a Stop of a run it holds, still reach the old backend,
  which ends once the wait does (a close still waiting for its job then fails as the backend's loss). A failed abort on Disconnect is retried once the next time a handle reaches BigQuery; one before a stop or restart is not (that backend ends).
- **`bigquery.cancelJobs`** (main only) cancels a saved profile's jobs without a connection handle, waits for DONE, and ends
  their sessions, answering `committedBeforeCancel`, `outcomeUnknown` or `abortFailed` per job.
- The restart, reload and crash prompts say BigQuery jobs carry on and re-attach.

In the workbench:

- **Tabs keep their jobs.** A BigQuery tab gets a job key at its first run and keeps it through hot exit and
  AutoRecover. A restored or recovered tab gets its running and finished jobs back from the records. Once it is
  connected (reconnecting by itself, or connected to BigQuery with Connect or Change Connection, which then does not ask
  about its jobs) it re-attaches to the newest, adopting its session. Older finished jobs are dropped, and older running ones stay
  with the tab, which asks about them on close, without re-attaching (an attach would replace the newest's results).
  While it is not connected, Messages says the job carries on. A finished job's reference only waits for its results:
  the prompt does not ask about it. A job cut off by a lost backend or network stays with the tab and re-attaches on the
  next connection, as does a running job whose re-attach failed for a passing reason (quota, a timeout, an expired
  sign-in, a busy session, a permission) or that ran in another project (kept for a connection to that project); another
  principal's job, one Stop cancelled or one whose results are gone is dropped. Each job is tried once per connection.
- **The prompt.** Closing a tab, Change Connection, Disconnect, a location switch or quitting asks about a tab that
  holds a job it runs, follows or left running, naming how long it ran and its estimate (with dollars unless Show cost as
  is Bytes only): Cancel the job, Leave it running, or Don't close (the default). It never
  asks about that tab's transaction: Cancel the job rolls it back, and Leave it running keeps it open in the session.
  When the tab's jobs run outside its session (restored ones not re-attached) and the session itself may hold a
  transaction, Leave it running is followed by the Commit or Roll Back box for that session.
  "Remember my choice" sets `queryExecution.bigQuery.closeRunningJob` (Ask, Cancel the job, Leave it running), which
  then answers without asking, except at a quit. Beside other executing queries (SQL Server, or a BigQuery run without a
  job such as Preview Rows) the box keeps their buttons, and the BigQuery choice is its "Leave BigQuery jobs running"
  checkbox. Cancel the job waits for the job to stop, then ends the session; a commit before the cancel, an unknown
  outcome or a session that could not be ended is shown in the tab's Messages, or as a notification once the tab is
  gone. A tab not connected has its jobs cancelled through its saved connection's credentials
  (`session.cancelRestoredJobs`). Leave it running drops the tab's records and shows the job ids with Copy Job IDs.
  Close All and Disconnect All keep tabs that hold jobs open without asking.
- **Quitting Varia leaves jobs running.** Kept tabs that hold a job are not asked about, their records stay, and their
  sessions stay open while a transaction may be open. Tabs that will not be restored are always asked, even with a
  remembered choice, and the box lists their job ids (up to 8 per tab with a count of the rest, for the first 10 tabs, job tabs listed first).
- **Close Results while a job runs.** It is available once a BigQuery job has started and asks the same three choices (Don't Close is
  the default), or follows the remembered choice. Cancel the job stops it as Stop does. Leave it running sends
  `query.cancel` with `detach`: the results close, the job keeps the tab's session, the next Execute waits for it (Stop
  cancels it), and closing the tab asks about it again while it runs.
- **Jobs without a tab.** After a start whose tabs were restored (or with nothing to restore), running jobs whose tab is
  gone (a crash, or an AutoRecover copy discarded, then asked at the next start) are asked about once: Cancel Jobs or
  Keep (the default). Jobs an AutoRecover copy may still reopen are left for it. Finished ones are dropped silently.
- **Deleting a saved connection.** One whose jobs still run asks first: Cancel Jobs and Delete, or Keep Connection (the
  default). Varia cannot cancel them once the connection is gone. Jobs that cannot be cancelled (broken credentials, a
  job that finished long ago) ask again, with Delete Anyway leaving them to BigQuery's job history; so does a connection
  whose job records cannot be read. Jobs in tabs still connected through it are left to those tabs (deleting it
  disconnects nothing), so their sessions stay as they are.
- **Idle sessions whose end failed.** They are shown as a notification after Disconnect, Reload or a backend restart.
  Only those from Disconnect are retried, the next time the connection reaches BigQuery; a Reload or restart ends the
  backend that held them.

Jobs that cannot be cancelled without a connection (one from an unsaved connection, or one whose saved connection was
deleted) are listed by id, to cancel in BigQuery's job history.

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

- **Setting.** Tools › Options › Query Results › BigQuery › Results: **Keep results** (`queryResults.bigQuery.residence`):
  Automatically, by size (the default), Always in memory (the budget truncates) or Always windowed in
  BigQuery; and **Block cache per windowed result** (`queryResults.bigQuery.windowCacheMiB`, 16 – 4,096 MiB, default 64), the blocks each
  windowed result keeps. Each query takes them as it starts; Preview Rows' 1,000 rows are always read into memory.
- **Deciding.** After the first page and before the grid opens: a result stays in memory when the rows arrived whole,
  under Always in memory, when its destination table cannot be read, or when its rows (the first page's measured cost
  per row, times the rows it will show within Maximum rows) fit half of what the query may still take from its budget and the global one. Otherwise it is windowed, and the
  first page seeds its first blocks. A windowed result counts at most 2,147,483,647 rows (the grid's 32-bit indexes);
  Messages says so when more than that would show.
- **Misestimate.** When the budget refuses an automatic in-memory result part way, it switches to windowed instead of
  truncating: its pages are freed, the grid keeps its place and drops its selection, and a screen reader hears that the
  result is now windowed. Low system memory is no misestimate: the query's read stops storing, as any query does (a Load into memory switches back, windowed), and a windowed
  result fetches no block while it lasts (its reads answer that the computer is low on memory, keeping the blocks cached).
- **Blocks.** About 4 MiB of measured rows each (256 – 16,384 rows, fewer for rows so wide that half the window cache,
  allowing the estimate's 25% margin, holds fewer), read with `tabledata.list` from the destination
  table, at most two at a time per result and four per connection, backing off on rate limits. The cache keeps the
  most recently used blocks within the window cache, reserving each block from the global result budget before it fetches
  (and any overrun after: a block too wide for the window cache answers that its rows are too wide; an overrun
  waits for the result's other fetches to settle; blocks a read waits for that do not fit together may pass the window
  cache, up to twice it, until the read is done; past that, the refusal says to raise it), and
  shows as Window cache in the Memory panel. Each grid on the result reads one block ahead either side, and one more the
  way it is scrolling (fewer when the cache holds few blocks, the one ahead first); a jump drops reads the grid no longer needs. A read waits up to 20 s for its blocks (less near its
  deadline), then the grid shows the rows it has and asks again, waiting longer each time; rows that still do not come
  after a few tries show Retry (a screen reader hears their cells as not loaded); a block only read ahead stops where the cache is full, never evicting the rows on screen,
  and read-ahead counts blocks at the widest their rows have come out.
- **Load into memory.** A windowed result of a finished run offers Load into memory on its grid's strip and in the results
  toolbar's ⋯ menu (Load Result into Memory in the palette) while its projection (the descriptor's `projectedBytes`, its
  measured row cost times its rows) fits the result memory free at that point; otherwise the strip says it is too large to
  load now and to close other results to make room. It runs `results.remoteQuery` kind `load`, which reads the whole
  table into memory under the budget (REST, or Storage Read when it qualifies; a script statement's rows always through
  REST, which keeps their order), so the in-memory features work on it. While it runs the strip counts the rows read and
  offers Stop, and the grid keeps the rows it showed and its place, drawing those not yet read as loading. A refusal part
  way, a failure or Stop leaves the result windowed, whole, with an empty cache that reads its rows from BigQuery again
  (Messages says whether it did not fit or the computer was low on memory); a load after BigQuery's temporary
  result table expired fails with `REMOTE_EXPIRED`. A second load of a result already loading is refused, and so is a load while
  another result of the same query loads (they share its budget) or while its query still runs.
  Closing the result stops the load, which then says the result was closed. Reads under way when it starts answer with the rows they have, and the
  grid reads again from memory.
- **Copy.** Copy of a windowed result reads the selected rows through its block cache (blocks not cached are fetched,
  outside the grid's read-ahead) and writes them through `ResultTextWriter` within the usual Copy limit: a selection
  whose text passes it is refused, before anything reaches the clipboard, with a pointer to Save Results As; one whose
  separators alone pass it is refused before any read. A transposed Copy reads its rows the same way. A sort or filter run
  in BigQuery is a result of its own, which Copy reads as itself. Rows already cached copy after the table expired; others
  answer `REMOTE_EXPIRED`. A result that starts loading into memory under a Copy refuses it (try again once loaded), and
  one released under it says so.
- **Save.** Save Results As streams every row the query keeps (Maximum rows honoured) from BigQuery to the file, never
  through the block cache or the store: through Storage Read when it qualifies (each stream in turn, a transient stream
  fault resumed at its offset without repeating rows), else `tabledata.list` pages, each page reserved from the result
  budget while it is written. It has the usual progress and Cancel, so the rows touch disk only in the file the user chose
  (written to a temporary file and renamed). A transposed Save reads its rows as Copy does, holding them in result memory (at most 128 MB). An expired table answers
  `REMOTE_EXPIRED` and leaves no file. Save reads the table itself, so it carries on through a load or Close Results. A sort or filter run in BigQuery saves as its own result.
- **Expiry.** A destination table lasts about 24 hours: once it has expired, a read answers with the cached rows from the
  start of its window, and one that starts on rows not cached answers `REMOTE_EXPIRED`. The grid keeps the rows it has, and
  its strip says BigQuery no longer keeps the result and offers Re-run…, which runs the tab's query again through Execute
  (the editor's text, or its selection, with the estimate and cost prompt); a grid shown while another tab is active
  does not offer it. A cache hit's destination table is an older one, which may expire sooner, so a
  windowed cache hit's caption adds "cached result: may expire early".
- **What waits.** Search, profiles, pivots, row identities and comparisons of a windowed result (its sorts, filters and
  value lists run in BigQuery, below) answer "This result is windowed in BigQuery" (`REMOTE_RESULT`) for now; a request whose result switches to
  windowed while it runs gets the same answer, and a grid's sort and filters are removed when its result switches (the
  screen reader hears so). The grid does not offer them where it can tell first: a transposed grid's strip does not
  suggest filtering, the Pivot builder says the result cannot be pivoted yet, the Compare popover leaves it out, and Search
  skips it.

### Sort and filter in BigQuery

A windowed result's grid sorts and filters in BigQuery: each sort, filter or value list is a query over the result's
temporary table, so it is billed, and its answer is a result of its own that the grid shows in place of the source
(`SqlService.BigQueryViews.cs`, `BigQueryViewSql.cs`, `src/renderer/src/results/remote-views.ts`; the protocol is
`results.remoteQuery`'s `view` and `distinct` kinds in docs/ipc.md). The header's sort buttons and funnels say "in
BigQuery" in their tooltips.

- **Estimate first.** Before each one, `bigquery.dryRun` estimates it (free) and the cost prompts of Cost › Before Execute
  apply as they do to Execute: above the threshold, or an incomplete estimate. A declined prompt runs nothing and the
  grid keeps what it showed; a failed estimate says why in the toolbar and runs nothing. The query's job, rows and cost
  go to Messages.
- **Sort.** Up to 16 keys, ascending with NULLs first and descending with NULLs last, as the in-memory sort orders them.
  BigQuery cannot order ARRAY, STRUCT, GEOGRAPHY, JSON, RANGE or INTERVAL columns: their sort button says so and refuses,
  and they have no funnel.
- **Value lists.** A funnel lists the column's values with BigQuery's `GROUP BY`, over the rows the grid's other filters keep,
  most frequent first, up to 100,000 values (past that the list is cut, and a checklist over it drops only the values it
  unticks). The list is a small result in memory, read whole, with the snapshot the checklist ticks; when the column has a filter of its own,
  each value starts ticked when the grid's filters keep it.
- **Filters.** A checklist, Equals, Not equals, Between, NULL and not NULL apply in BigQuery. The values a filter names
  are the value list's rows, read from its table in BigQuery (so the estimate includes that small scan, and no value is
  sent), and the filter keeps the list for as long as it applies; once the list's table expires, the filter says to open
  the column's filter again. A checklist keeps the ticked values when the list is whole and they are no more than the
  others, and otherwise drops the unticked ones, as in memory. In a FLOAT64 column NaN is one value, which a filter keeps
  or drops like any other.
  Filters that name the grid's rows rather than values (Filter by Selection, duplicates, Keep Selected Rows) say they need
  the rows in memory.
- **The view.** It is held under the source's budget, and windowed in its turn when it is large. It reads the whole result
  table, so under Maximum rows a sort or filter can show rows the grid had not held (its answer keeps Maximum rows), and a
  value list counts every row. A filter
  with no sort shows the rows in BigQuery's order, which need not be the query's own, and rows that tie on the sort keys
  come in any order; sort to fix one. A newer sort or filter
  replaces it (the old one is released once the grid shows the new one); Stop cancels the BigQuery job; closing the
  results or the tab releases both. BigQuery's resource errors on a large sort suggest filtering first.
- **An expired table.** Once the source's temporary table has expired, a sort or filter answers `REMOTE_EXPIRED`, and a
  value list that has expired answers the same when a filter names it. In emulator mode, where jobs run outside the
  tab's session, the estimate notices the table is gone and the original query runs again with the sort or filter
  around it, when the query has no parameters and nothing in it can change between runs; Messages says so.

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

## Object Explorer

A BigQuery connection's tree loads through `explorer.children`, the method SQL Server's uses, from BigQuery's free REST
listers; nothing in it runs a job.

- **Shape.** The connection node lists the billing project (sublabel "billing project"), then the extra projects. A project
  lists its datasets (`datasets.list`, sublabel the location). A dataset has six folders: Tables, Views, Materialized Views,
  External Tables (`tables.list` filtered by type; a snapshot is a table with the snapshot icon, a clone is a table),
  Routines (`routines.list`, icon by routine type, sublabel a non-SQL language) and Models (`models.list`, sublabel the model
  type). A table-like object has Columns (`tables.get`'s schema, sublabel the type, `ARRAY<…>` for a repeated column and
  ", required" for a required one); a STRUCT column expands to its fields, up to BigQuery's 15 levels.
- **Paging and limits.** Lists page with BigQuery's own page tokens (carried in the cursor as base64url), Columns by offset;
  each listing has a 30 s budget, and a failure is the row's error, as SQL Server's are. Names a kind's rule refuses are
  dropped, so they never reach a menu or a script.
- **Rate limiter.** Every metadata read (listers, Preview Rows, Properties, Script As' `tables.get` and `routines.get`) goes
  through one limiter per principal: at most 16 calls in flight across all of the principal's connections, since BigQuery's
  per-user API limits count the principal. A rate-limit refusal (429, or 403 `rateLimitExceeded`) retries with jittered
  backoff until the call's deadline; other transient failures retry a few times; anything else answers at once.
- **Names in SQL.** BigQuery has no `QUOTENAME` and takes no identifier as a parameter, so a name reaches SQL text only through
  `BqNames` (C#): its kind's rule (the same as `src/shared/bigquery/names.ts`), then backticks with backslashes and backticks
  escaped. A name the rule refuses throws `INVALID_PARAMS` before any text is built. Values are always query parameters.
- **Copy and drag.** A node inserts its backtick-quoted path (`` `project.dataset.table` ``; a column each part quoted).

### Preview Rows

Preview Rows (Object Explorer's context menu on a table, snapshot or clone) opens a new query tab whose text is the
`SELECT * … LIMIT 1000` it stands for, then fills its results from `tabledata.list`, which is free and runs no job, so no cost
prompt appears. It rides on `query.execute` with a `preview` target: the tab's earlier results are released, and Stop, Close
Results and tab close behave as for a query. It reads at most 1,000 rows through the query results' converter and budget; the
rows past them are counted, not read. Views, materialized views and external tables have no stored rows to list, so the menu
does not offer it (Script As › SELECT queries them, billed). A table with row access policies answers `ROW_ACCESS`, since
`tabledata.list` cannot apply them. Execute on the tab runs its text as a normal, billed query.

### Script As

Script As serves BigQuery's tables, snapshots, views, materialized views, external tables and routines.

- SELECT, INSERT, UPDATE, DELETE and DROP are local templates from `tables.get` (a routine's DROP from `routines.get`, which
  uses DROP PROCEDURE for procedures, DROP TABLE FUNCTION for table functions and DROP FUNCTION for scalar and aggregate functions), free. SELECT lists the top-level columns, ends with
  `LIMIT 1000` and says that LIMIT does not lower the bytes billed. INSERT, UPDATE and DELETE are offered for tables only (a
  snapshot's rows cannot change) and use SSMS's `<name, type,>` placeholders.
- CREATE reads the object's own DDL from `INFORMATION_SCHEMA.TABLES` or `ROUTINES` (the `ddl` column), a query BigQuery
  bills. Varia first dry-runs it (`estimateOnly`, free), applies the same cost prompts as Execute (Cost, above), then runs it
  in the dataset's location under the connection's maximum bytes billed, else the one the prompts set. The object's name is a
  query parameter. No DDL ever runs.
- A new query window opens on the object's dataset when it is in the billing project.

### Properties

Properties on a table-like object opens a read-only document tab from one `tables.get` (free, `bigquery.properties`): Table
(full name, type, location, description, labels, base table of a snapshot or clone), Storage (rows, logical, long-term and
physical size), Layout (partitioning, partition filter, clustering, column count) and History (created, last modified,
expires, snapshot time), in UTC and binary units. Empty facts are left out and values are clipped at 2,000 characters.

Refresh on a project or dataset node also re-reads it in the Search Objects index, on a node below a dataset that dataset,
and on the connection's node the whole index ([Search Objects › BigQuery](object-search.md#bigquery)).

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
| `REMOTE_RESULT` | Sort, filter, search, profiles, distinct values, pivots, row identities or comparisons of a windowed result | "This result is windowed in BigQuery: its rows are not in memory, so this is not available for it yet." |
| `REMOTE_EXPIRED` | Rows of a windowed result not cached, or a load into memory, once BigQuery's temporary result table expired (about 24 hours) | "BigQuery no longer has this result…": run the query again |
| `BUSY` | A load (`results.remoteQuery`) while the query that made the result still runs, or while another result of that query loads | Refused until that query or load has finished |
| `ROW_ACCESS` | Preview Rows on a table with row access policies | Use Script As › SELECT to query it (billed) |

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
  a misestimate through REST and Arrow, Load into memory with its refusal and Stop, and Copy and Save (the Copy limit,
  transposed rows across blocks, expiry, release, Save through Storage Read and REST with Maximum rows and a resumed stream). `tests/bigquery-remote-results.test.ts`,
  `tests/results-port.test.ts` and `tests/result-client.test.ts` cover main's and the renderer's side.
  `tests/bigquery-credentials.test.ts`, `tests/bigquery-connection-store.test.ts` and
  `tests/bigquery-connection-open.test.ts` cover main's side; `tests/bigquery-connect-form.test.ts`,
  `tests/bigquery-connect-dialog.test.ts` and `tests/bigquery-workbench.test.ts` the dialog and the workbench;
  `tests/bigquery-execute.test.ts` and `tests/bigquery-cost.test.ts` execution's contracts and cost text. The dry-run
  checks in `BigQueryChecks` cover `bigquery.dryRun` (the body, each incomplete reason, a refused query's `[line:column]`,
  the limits); `tests/bigquery-dry-run.test.ts` the cost rules, the prompts, the chip and the diagnostics loop, and
  `tests/queries.test.ts` Execute's cost gate. The emulator does not dry-run, so no live check covers it.
  `BigQueryExplorerChecks` covers Object Explorer: every name rule against hostile names, the Script As templates, the
  listers, cursors and STRUCT fields against the REST fixtures, the rate limiter and its retry, Preview Rows (no job,
  `tabledata.list`'s request, a refused view, `ROW_ACCESS`), Script As › CREATE's dry run, and Properties' facts;
  `tests/bigquery-explorer.test.ts` the shared rules and schemas, `tests/scripting-service.test.ts` CREATE's cost gate, and
  `tests/queries.test.ts` Preview Rows' path.
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
