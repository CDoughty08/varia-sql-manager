# BigQuery support plan (0.10.0)

Status: **agreed with the owner on 2026-11-15**, then revised after an adversarial review the same day. The owner's
answers to that review are decisions 21–24 and 50–53, and the details the review rounds settled are decisions 25–49. Nothing here is
implemented yet. The lanes below become PRs. [Decisions](#decisions) records the owner's answers.

0.10.0 is meant to deliver two things: BigQuery support and SQL Server Agent support. Agent is planned separately
(docs/agent-plan.md). This page covers BigQuery and calls out the shared infrastructure both plans touch (marked
**Shared**).

## Goals and non-goals

Goals for 0.10.0:

- Connect to BigQuery with Google credentials the user already has, with no secret in clear on disk.
- Browse projects, datasets, tables, views, routines and models in Object Explorer.
- See the project's job history, live, and cancel or re-open jobs, so nothing sends the user back to BigQuery Studio.
- Run GoogleSQL, scripts included, with results that look like one continuous result set whatever their size. A result
  that fits the budget is read whole into memory, so every result feature works. A larger one stays in BigQuery and the
  grid reads a window of it, with sort and filter run in BigQuery. Stop works and cost is always visible.
- GoogleSQL editing: highlighting, completion from the Search Objects index, and errors from dry runs.
- SQL Server behaviour stays exactly as it is. SQL Server-only features are hidden for BigQuery connections, never
  half-working.

Not in 0.10.0 (candidates for 0.11, listed in [Later](#later)): browser OAuth sign-in with a Varia-owned Google client,
a viewer for query plan stages, table edit actions, BigQuery ML, and writing results back to tables.

## What the code already has

- The language contract already names `bigquery` (`src/shared/language-service.ts`) and has `project`/`dataset` context
  fields. `LanguageServiceBroker` routes by provider id, though it has only the SQL Tools provider.
- `ConnectionInfo.providerId?` exists, but main pins it to `'sqlserver'` and the backend record lacks it. The connection
  principal and target use a second spelling, `provider: z.literal('sqlServer')` (`connection-targets.ts`,
  `connections.ts`). This plan uses one id.
- The results pipeline below the reader is engine-neutral: `ResultStore`, `ResultSetBuffer` (`BeginRow`, `TryCommitRow`,
  `Seal`, `Complete`) and `PageBuilder` (text and binary cells). The SQL Server coupling sits in `ColumnPlan`
  (`Results/ColumnReaders.cs`), which reads a `SqlDataReader`, and in **type classification**: `ResultViews.KindOf`
  knows only SQL Server type names, so an `INT64` column would sort as text. Several readers after the store classify
  by type name the same way ([Column types](#column-types-are-engine-neutral)).
- Everything else is SQL Server-shaped: `ConnectionOptions`, the auth modes, `connectionKey`/`credentialBinding`, the
  principal pin and workspace seal, `SqlService`'s connection dictionaries, the Explorer catalogue's kinds and scope
  fields, identifier limits of 128 characters, and the context keys (the only "engine" keys today are SQL Server
  editions: `box`/`managedInstance`/`cloud`).
- `isQueryDocument` is `documentKind === 'sql'` and is read at about 60 sites, so a second query document kind would
  have to touch all of them ([GoogleSQL in Monaco](#googlesql-in-monaco-bq-4)).
- The Search Objects index is not yet read by completion. The query-editor direction agreed on 2026-11-14 makes it the
  single metadata source, and BigQuery should be its first consumer that does not use SQL Tools.

## 1. Connections

### Provider in the connection model (BQ-0, **Shared**)

- One `ProviderId = 'sqlserver' | 'bigquery'` in `src/shared/`. `postgresql` stays reserved in the language contract
  only. The principal's and target's `'sqlServer'` literal reads as `'sqlserver'` (a zod preprocess) and is written as
  `'sqlserver'` from then on; a test reads a file holding the old spelling.
- `ConnectionOptions` becomes a discriminated union on `provider`. The SQL Server branch keeps today's strict fields
  and a missing `provider` means `sqlserver`. The BigQuery branch is a strict shape of its own:

  | Field | Notes |
  | --- | --- |
  | `provider: 'bigquery'` | |
  | `project` | The billing project that jobs run in. Required. Validated as a project id, domain-scoped ids (`example.com:proj`) included, at most 128 characters |
  | `location?` | The default job location (`US`, `EU`, `us-east1`, …). Detected from the default dataset when omitted |
  | `dataset?` | The default dataset for unqualified names (the "database" dropdown's role), at most 1,024 characters |
  | `extraProjects?` | Read-only projects shown in Explorer (for example `bigquery-public-data`), at most 16 |
  | `authentication` | `gcloud` \| `serviceAccountKey` \| `externalAccount` (see below) |
  | `keyFile?` | On the wire, an opaque reference: a token from `connections.pickKeyFile` for an unsaved entry, or the saved profile's id. The path itself lives only in main's `bigquery-connections.json`; the renderer sees the file name |
  | `impersonateServiceAccount?` | A service account email, applied on top of any authentication mode |
  | `maximumBytesBilled?` | A per-connection override of the global cap, sent with every job |
  | `displayName`, `color`, `environment` | Shared with SQL Server, so the Production tag works |

- BigQuery's authentication modes are their own enum (`bigQueryAuthenticationModes`), not new members of SQL Server's
  `authenticationModes`, so SQL Server's mode lists, Entra rules and `EntraModes.cs` stay closed.
- `connectionKey` and `credentialBinding` dispatch on the provider. A BigQuery binding hashes the provider, project,
  authentication, key path, impersonation target and resolved principal.
- The principal pin, the reuse check and the workspace seal take a provider-tagged union: SQL Server's shape as today,
  and for BigQuery `{ provider, project, principal }` where `principal` is the pinned identity
  ([Identity pinning](#identity-pinning)). Schemas that use `connectionTargetOptionsSchema.shape` today change to the
  union's branches, since a union has no `.shape`.
- `ConnectionInfo` gains `providerId` in the backend record. Main's literal widens to the union.
- Files BQ-0 touches beyond the schemas: `connection-principal.ts`, `connection-reuse.ts`,
  `connection-workspace-seal.ts`, `auth.ts`, `connection-open.ts`, `connection-requests.ts`, `EntraModes.cs`, and
  `methods.ts` (the `connect` deadline, which gains BigQuery's discovery time).
- **C#:** `ConnectOptions` stays SQL Server's positional record. `connections.connect` gains a converter that reads
  `provider` first: missing or `sqlserver` parses today's record (still with `UnmappedMemberHandling.Disallow`),
  `bigquery` parses a separate `BigQueryConnectOptions` record with its own limits.
- **Name rules differ per kind.** Projects: Google's project id grammar. Datasets: letters, numbers and underscores,
  up to 1,024 characters. Tables: Unicode letters, marks, numbers, connectors, dashes and spaces (`table 01`), up to
  1,024 UTF-8 bytes. Columns: the flexible column-name set, up to 300 characters. The BigQuery branches check each kind's
  rule in zod and C#; SQL Server's 128 characters stay.
- **Tab and target records** carry the provider and BigQuery's lengths too: the session file's tabs (version 3), a
  version 2 AutoRecover record (`files/recovery.ts`), and target associations (`connection-targets.ts`), each with a
  migration test. A 0.9.0 record reads as SQL Server.
- **Shared with Agent: provider gating.** Context keys `activeDocumentProvider`, `explorerProvider` and
  `explorerSelectionProvider` (`'sqlserver' | 'bigquery' | ''`), beside today's `explorerServerEngine` and
  `explorerSelectionServerEngine`. Catalogue entries (commands, menus, Explorer kinds and actions, live sources,
  settings pages, Script As kinds) get a `providers` field. **The default is `['sqlserver']`**, so an entry that forgets
  the field is hidden for BigQuery (a safe failure) rather than half-working. BQ-0 declares
  `providers: ['sqlserver', 'bigquery']` on the provider-neutral entries (editing, results, layout, help and so on), and
  each BigQuery lane widens the entries it makes work. The lint: an entry whose `when` names a provider key must agree
  with its `providers`, and an entry that declares `bigquery` must not run a method whose policy lacks it. Agent's entries
  take the default, as docs/agent-plan.md already says.
- **Shared: method gating.** Each `methodPolicies` entry gains `providers` (default `['sqlserver']`, so a new method
  is SQL Server-only until it says otherwise). Main checks it against the handle's provider before sending, and
  `DispatchAsync` checks it again first thing. A call that fails it answers `UNSUPPORTED_PROVIDER`, a value, never a
  throw. This is a new code because the existing `NOT_SUPPORTED` means "this server cannot have it" (an Explorer row)
  and `AUTH_UNSUPPORTED` is an authentication failure; neither says "this engine has no such method". BQ-0 tests both
  checks with a stub provider.

### Connection files and migration (BQ-0, **Shared**)

0.9.0 parses `connections.json` and `session.json` strictly and would quarantine a file holding a BigQuery entry, losing
every SQL Server connection with it. So BigQuery never writes into a file 0.9.0 reads (decision 24):

| 0.9.0 file | 0.10.0 file | What moves |
| --- | --- | --- |
| `connections.json` | `mssql-connections.json` | Every connection, unchanged |
| (none) | `bigquery-connections.json` | BigQuery connections only |
| `saved-passwords.json` | `mssql-saved-passwords.json` | Every saved password (ciphertext, unchanged) |
| `Session/` (`session.json`, `previous.json`) | `WorkbenchSession/` | Tabs of every kind, workspace and seal; schema version 3 with the provider-tagged workspace |
| `AutoRecover/` | `WorkbenchAutoRecover/` | AutoRecover snapshots, per tab; record version 2 |

- At startup, when a 0.10.0 file is missing and its 0.9.0 file exists, main copies the 0.9.0 file's parsed content to
  the new file atomically (`json-file.ts`). The 0.9.0 files are never written again and stay as a frozen snapshot, so
  downgrading to 0.9.0 opens the state from the moment of upgrade. A later release deletes them (listed in
  [Later](#later)).
- An unreadable 0.9.0 file is quarantined by the existing rule, never migrated. A migration that fails leaves the new
  file absent, so the next start retries.
- Saved passwords move too, because 0.9.0 reconciles `saved-passwords.json` against the connections file it reads and
  would delete the passwords of every profile created under 0.10.0. The SQL Server binding hash does not change, and
  BigQuery adds no secrets in 0.10.0.
- Each connection file keeps today's limits on its own (200 profiles, 30 history entries); the MRU merges both by time.
- Known limit, in the release notes: after a downgrade, changes 0.9.0 makes to its own files are not carried back on
  the next upgrade, because the 0.10.0 files already exist; passwords saved under 0.9.0 after a downgrade included.
- Tests: migration from each 0.9.0 file, a second start that does not migrate again, a quarantined source, a failed
  write, and a 0.9.0 parser reading the frozen file after a 0.10.0 session.

### Authentication

| Mode | How it works | 0.10.0 |
| --- | --- | --- |
| **gcloud credentials (ADC)** | ADC's search order: `GOOGLE_APPLICATION_CREDENTIALS`, then the file `gcloud auth application-default login` wrote, then the metadata server. Varia does not hand the file to `GetApplicationDefaultAsync` blindly: main finds and reads it, and the backend checks its `type` and loads it with the same typed loads and pins as the explicit modes (`authorized_user`, `service_account`, `external_account`, `impersonated_service_account`), so an ADC file cannot bypass decision 23. Varia stores nothing. The dialog says how to sign in with gcloud when no credentials are found | Yes (the default) |
| **Service account key** | The user picks a JSON key in main's open dialog, through a new main IPC channel `connections.pickKeyFile` (preload method, `trusted()`, zod) that answers an opaque token and the file name. Main keeps the path behind the token, then per profile id once saved (the renderer never sends a path), checks it is a regular file named `.json` of at most 64 KiB, reads it and sends it to the backend in a sensitive request. The backend loads it only as `CredentialFactory.FromJson<ServiceAccountCredential>`, never the obsolete `GoogleCredential.FromJson`, which would accept any credential type. Its content is never echoed in an error | Yes |
| **Workforce/Workload Identity Federation** | An `external_account` or `external_account_authorized_user` JSON config, typed load, same file rules. An untrusted config can make Varia fetch URLs or run programs, so the backend pins every URL it names by scheme, host and path, allowing only documented parameters: the token and impersonation URLs must be Google's STS and IAM credentials endpoints, and `universe_domain` must be `googleapis.com`; `credential_source` may be `file`, AWS (metadata host `169.254.169.254` or `fd00:ec2::254`; its `{region}` verification URL is signed, never called) or Azure (the instance metadata token URL with its `resource` parameter); any other host and every `executable` source are refused, naming the field (decision 23). A file source rotates (projected Kubernetes and OIDC tokens), so the backend asks main for its content on every token exchange through a custom subject-token supplier; main caps it at 64 KiB and refuses Varia's own files and known credential files (ADC, gcloud) | Yes |
| **Service account impersonation** | `impersonateServiceAccount` applied with `CreateImpersonated` on top of any of the above | Yes (small) |
| **Browser sign-in (OAuth)** | Loopback redirect plus PKCE, through a Varia-owned Google OAuth client. The BigQuery and cloud-platform scopes need Google's sensitive-scope verification (until then: an "unverified app" screen and a 100-user cap). The device flow cannot be used: Google does not allow BigQuery scopes on it | **Later**, after verification (decided) |

Rules (these follow the existing invariants):

- Tokens and key material live only in backend memory, as Entra tokens do. Neither reaches main's logs, the renderer,
  or a receipt. A remembered key file is remembered by path only (decision 2).
- **Pre-connect requests.** The dialog's project picker and account line run before a connection exists, so
  `bigquery.account` and `bigquery.projects` are sensitive in both method lists: the renderer sends a profile id or, for an unsaved entry, the key file token, and
  main injects the credential material.
- **URL pins for every credential type.** A key or ADC file can name where tokens are fetched, so for every type
  (`service_account`, `authorized_user`, `impersonated_service_account`, both external kinds) `universe_domain` must be
  `googleapis.com`, and `token_uri`, the impersonation URL and, recursively, every URL in `source_credentials` must be
  Google's documented endpoints. Anything else is refused naming the field, with a test per type (decision 48).
- **Federation file sources are confirmed** (decision 49). A config's `credential_source.file` could name any readable
  file (`~/.aws/credentials`, an SSH key) and its content would go to Google's STS. So the first time a config is used,
  the dialog shows the resolved path and asks; the path is part of the credential binding, so a changed path asks
  again, and background reconnect never asks: it fails until the user confirms in the dialog.
- The connect probe is a dry run of `SELECT 1` in the billing project. It proves `bigquery.jobs.create` and costs
  nothing. `projects.list` (BigQuery v2, not Resource Manager, which needs another API enabled) fills the project
  picker. `datasets.list` fills the dataset picker, and `datasets.get` on the default dataset gives the location.
- Background reconnect works for ADC, key files and external accounts, which never need interaction. A browser sign-in
  would follow the Entra rule: never escalate to a browser in the background.
- **Test endpoint.** `VARIA_TEST_BIGQUERY_ENDPOINT` points Varia at the emulator. It is read only by unpackaged builds,
  and when it is set Varia uses anonymous credentials and sends no Google token (decision 15, revised).

#### Identity pinning

The resolved principal is the evidence, pinned at connect and checked again on every reconnect and credential refresh:

| Mode | Pinned identity |
| --- | --- |
| Service account key | The key's `client_email` |
| ADC user credentials | The token's email from Google's tokeninfo endpoint (ADC's default scopes allow it) |
| ADC on a metadata server | The metadata server's service-account email endpoint |
| External account (OIDC, SAML, file) | The audience plus the subject token's subject; with impersonation, the impersonated account |
| External account (AWS) | The audience plus the role name from the metadata URL (an AWS subject token is a signed request, not a JWT); with impersonation, the impersonated account |
| Any mode with impersonation | The impersonated account, plus the base identity above |

A credential re-pointed at another account (an ADC file rewritten by `gcloud auth application-default login`) fails
`AUTH_IDENTITY` instead of silently switching accounts. A revoked or expired refresh token (`invalid_grant`) fails
`AUTH_EXPIRED` with the gcloud command to sign in again. Neither is retried in the background.

#### Errors

Google's failures become Varia error values, with user text and a recovery. Each row has an offline fake test.

| Google reason | Varia code | User text and recovery |
| --- | --- | --- |
| `invalid_grant` on refresh | `AUTH_EXPIRED` | "Your Google sign-in has expired." Shows `gcloud auth application-default login`; Retry |
| Key or config file missing or unreadable | `AUTH_KEY_FILE` | "The key file could not be read." Browse… to pick it again |
| Pinned identity changed | `AUTH_IDENTITY` | Names both accounts' kinds, not their emails, in logs; the dialog shows the emails |
| `accessDenied` on `jobs.create` | `PERMISSION_DENIED` | Names the missing permission (`bigquery.jobs.create`) and the project |
| `accessNotConfigured` | `API_DISABLED` | "The BigQuery API is not enabled for this project." Link text, not a link, to the console page |
| Billing disabled (`billingNotEnabled`) | `BILLING_DISABLED` | Explains the sandbox limits (no DML) |
| Location mismatch (`notFound` on a dataset in another location) | `LOCATION_MISMATCH` | Names both locations; offers the location prompt (decision 18) |
| `quotaExceeded`, `rateLimitExceeded`, HTTP 429 | `QUOTA` | Says which quota; rate limits back off and show as progress, quotas fail |
| `responseTooLarge` | `RESULT_TOO_LARGE` | "The result is over BigQuery's 10 GB result limit." Suggests a filter or aggregate (decision 21) |
| `bytesBilledLimitExceeded` | `COST_CAP` | Shows the estimate and the cap, and links to Cost settings |
| Legacy SQL (`#legacySQL`, a legacy-only error) | `LEGACY_SQL` | "Varia runs GoogleSQL only." (decision 13) |
| Network loss mid-job | `CONNECTION_LOST` | The tab keeps the job record; when the network returns, Reconnect re-attaches to the job (decision 51) instead of re-running it |
| Destination table gone | `REMOTE_EXPIRED` | Offers Re-run with the estimate |
| `tabledata.list` refused by row access policies | `ROW_ACCESS` | "Preview needs access to every row of this table." Offers Script As SELECT |

Where the codes live (main turns an unknown backend code into `BACKEND_ERROR`, and `tests/ipc-lint.test.ts` requires
each envelope code in `errorCodes` and docs/ipc.md):

| Codes | Where | Lane |
| --- | --- | --- |
| `UNSUPPORTED_PROVIDER` | Envelope `errorCodes`, and every per-method enum (`explorerErrorCodes`, `actionErrorCodes`, `liveErrorCodes`, `ssisErrorCodes`, `scriptErrorCodes`) | BQ-0 |
| `PERMISSION_DENIED` | Envelope (today only in `explorerErrorCodes`), so connect and query failures do not become `BACKEND_ERROR` | BQ-1 |
| `AUTH_EXPIRED`, `AUTH_KEY_FILE`, `API_DISABLED`, `BILLING_DISABLED`, `QUOTA`, `LEGACY_SQL` | Envelope, and `explorerErrorCodes` for Explorer rows | BQ-1 |
| `LOCATION_MISMATCH`, `RESULT_TOO_LARGE`, `COST_CAP` | Envelope (query and result methods) | BQ-3a |
| `REMOTE_RESULT`, `REMOTE_EXPIRED` | Envelope (result methods) | BQ-3c-1 |
| `ROW_ACCESS` | Envelope (`bigquery.preview`) | BQ-5 |

### Connect dialog, saved connections, Explorer

- The dialog gets a **Server type** select (SQL Server | BigQuery) at the top. It defaults to the last type used, so
  SQL Server users see no difference. BigQuery swaps the field block: an account line (from `bigquery.account`, before
  connecting), Project (an editable combo listing `projects.list`), Authentication, Key file (Browse… through main's
  dialog), Location, Default dataset, and an Advanced section with Maximum bytes billed, Impersonate service account and
  extra projects (a second project picker). Encrypt, TLS and the SqlClient advanced options are not shown.
- Switching Server type keeps each type's fields, so switching back restores them; Undo in the dialog restores the
  previous type.
- Saved connections, favourites, MRU, Production colour and auto-reconnect work on the union. Server-keyed displays
  (MRU, tab captions, window title, receipts) show the project id where SQL Server shows the server name. Registered
  Servers' Browse stays SQL Server-only.
- In Object Explorer a BigQuery connection is a root of its own (see [Object Explorer](#script-as-and-actions-bq-5)).

## 2. Results: in memory or windowed

A BigQuery result can be one row or billions, so one strategy cannot serve both. Each result set settles on one of two
**residences** once its job has finished, because only then does BigQuery know the exact row count and size. The grid
looks the same in both: one continuous result, and the user never sees a BigQuery page token or a "load more".

### Choosing the residence

- When a job (or each child job of a script) completes, Varia reads two things. First, the destination table's
  `numRows` and `numBytes` (`tables.get`, free). Second, the first page of rows through REST (at most 500 rows), which
  the grid shows at once whatever the residence.
- From that first page Varia measures what a row costs in its own store (display text, offsets, bitmaps) and projects
  the whole result's size. BigQuery's `numBytes` is a cross-check, not the figure used, because display text can be
  larger or smaller than BigQuery's storage.
- **In memory** when the projection fits in half of what the query may still take (the smaller of its own half of the
  budget and the global budget's free room). The other half is slack for a misestimate. **Windowed** otherwise.
- A result that arrives whole in the first response (small results) is in memory at once, with no projection.
- Setting `queryResults.bigQuery.residence`: **Automatic** (default), **Always in memory** (reads until the budget
  truncates, SQL Server's behaviour), or **Always windowed**. Until BQ-3c lands, every result is in memory and the
  setting is hidden; BQ-3a reads into memory and truncates, as SQL Server does.
- The descriptor gets `residence: 'memory' | 'remote'`, `rowsTotal` (BigQuery's `totalRows`) and `revision`. All are
  optional fields, so the protocol stays v2 (as `name` did). The caption and status bar say "52,341,118 rows · windowed
  in BigQuery", or "1,204,331 rows" for an in-memory result.
- **Residence switches** (a misestimate, Load into memory) bump `revision`. The renderer then drops its cached pages and
  row identities for that set, keeps the scroll position, and clears the selection, saying so in the status bar, since
  a different read can return rows in a different order.
- **Row limit.** The grid addresses rows with 32-bit indexes. A windowed result over 2,147,483,647 rows is shown up to
  that row with an explicit truncation note naming the true total; a filter or Save covers the rest.

### Column types are engine-neutral

`ResultColumn` gains `sortKind` (`integer`, `decimal`, `float`, `boolean`, `date`, `time`, `datetime`, `timestamp`,
`binary`, `text`, `json`, `other`), set by one factory that every producer of `ResultColumn` calls: the SQL Server
reader, `ResultPivot`, `LiveTables`, `SqlService`'s synthetic columns and `SyntheticRows`. Given a SQL Server type name
the factory applies today's rules, so SQL Server behaviour does not change; BigQuery passes GoogleSQL types. Every
place that classifies by type name today reads `sortKind` instead: `ViewSorter` and `KindOf`, `ResultTextWriter`,
`ResultPivot` and `pivot.ts`, `ColumnProfiles`, `RowIdentity`, `HighlightsService`, `measure.ts` and `ResultsService`.
A test runs each of them with SQL Server's descriptor before and after and expects identical output.

`dataType` keeps the full GoogleSQL type text (`ARRAY<STRUCT<a INT64, b STRING>>`), truncated in C# to the descriptor's
256-character limit with an ellipsis. A result with more than 4,096 columns (the descriptor limit) keeps the first
4,096 and says so in Messages; BigQuery allows 10,000.

### In memory: every result feature works

- Rows are read with the **Storage Read API** (Arrow) from the job's destination table into `ResultStore`, as a
  `SqlDataReader` is: an `ArrowColumnPlan` writes each record batch into `PageBuilder`. Budget, packing, room for a
  query, sort, filter, pivot, compare, profile, search, highlights, Copy and Save all work unchanged.
- **Order:** Storage Read streams do not keep a table's row order between them. When the statement has a top-level
  `ORDER BY`, Varia asks for a single stream. The backend decides this per statement with its own GoogleSQL scanner
  (comments, strings and nesting aware), not the renderer's tokenizer. Otherwise it reads up to four streams in parallel
  and appends them as they come: without `ORDER BY`, SQL defines no order, which is also the rule BigQuery's own Python
  client follows.
- **REST fallback.** Varia uses `tabledata.list` (free, `formatOptions.useInt64Timestamp=true`) in three cases: the
  project has not enabled the Storage Read API, the principal lacks `bigquery.readsessions.create`, or the result is
  under about 20 MB, where a read session costs more than it saves. For the first two, Messages says once per connection
  why reads are slower.
- **A misestimate:** if the budget refuses a row partway through an Automatic in-memory read, the set does not truncate.
  It **becomes windowed**: its stored pages are released and a `resultSet.residence` event updates the descriptor (with
  a new `revision`). Under **Always in memory** it truncates with today's reasons and notes, and a stop is never undone.
- **Cost:** Storage Read charges per byte read. Whether that charge applies to a query's temporary result table is
  unconfirmed. BQ-3b checks it against the pricing page and the real project before it ships. If reads of result
  tables are billed, a setting (`queryResults.bigQuery.storageRead`, default on) lets the user keep to free REST reads.
- **Golden test:** the same rows read through REST and through Arrow produce byte-identical display text, for every
  type in [Types and display](#types-and-display).

### Windowed: the rows stay in BigQuery

BigQuery's own limit shapes this mode: a query result without a destination table (an "anonymous" table) can be at most
10 GB compressed, and the BigQuery console has the same limit; its workaround is a named destination table. Varia
accepts that ceiling in 0.10.0 (decision 21): a larger result fails with `RESULT_TOO_LARGE` and a suggestion to filter
or aggregate. "Save to a BigQuery table" in 0.11 lifts it.

- The rows stay in the job's anonymous destination table, which BigQuery keeps for about 24 hours on a best-effort
  basis and does not bill as storage. **It can disappear at any time.** The result store holds a **remote result**: its
  descriptor, its schema and a block cache, but no stored pages. Its state is `complete` and `rowsAvailable` is
  `rowsTotal` (capped as above).
- **Block cache.** `results.read` for a row window is served from cached blocks. A block is read with
  `tabledata.list?startIndex=&maxResults=`, which is free and allows random access. Blocks are sized by bytes, not rows:
  from the first page's measured row size, a block is about 4 MiB of display text, between 256 and 16,384 rows, read as
  a bounded sequence of pages following `pageToken`. The cache is LRU per result, 64 MiB by default
  (`queryResults.bigQuery.windowCacheMiB`), charged to the global budget like a live table, shown in the Memory panel as
  "window cache", and released with the result.
- **Read-ahead** is tracked per viewer (a grid, a popout, Transpose): the blocks on either side of its last read plus
  one more in its direction of travel. A jump (Ctrl+End, a dragged scroll thumb, Go to Row) fetches its target block
  first and cancels that viewer's stale read-ahead.
- **Fetch lane.** Remote fetches run on their own pool (four in flight per connection, two per result), not the result
  slots that `results.*` methods hold, so a slow fetch never blocks another tab's reads. `results.read` waits on a fetch
  under its existing deadline and credit; when the deadline passes, the window answers with the rows it has and the grid
  keeps drawing the rest as loading (`LOAD`) until a later read fills them. `results.rowBytes` and `results.rowIds` run
  on the control lane (10 s), so for a remote result they answer from the cache only and never touch the network: rows
  not cached come back as not yet loaded.
- **Rate limits** (`rateLimitExceeded`, 429) back off with jitter and show as progress ("Waiting for BigQuery…"), never
  as an error, until the method's deadline.
- **The grid** already covers the rest. Its scaled scrolling (`grid/scroll.ts`, Mode B) spans billions of rows, and
  cells not yet fetched draw with its existing loading state.

**Sort, filter and value lists run in BigQuery**, as BigQuery Studio's do:

- A sort or filter becomes a **derived remote result** with its own descriptor and entry id, as a held view is today.
  Its query is ``SELECT * FROM `dest` WHERE … ORDER BY …``, built from constant templates in `BigQuerySql`, columns
  through `BqNames.Quote` from the result's own schema, every value a query parameter. Its own destination table is
  then read by the same residence rule, so a filter that shrinks a billion rows to fifty thousand brings that view into
  memory, and pivot, compare and profile work on it.
- Querying the anonymous table is cheap but best-effort (Google discourages depending on cached results). When it is
  gone, Varia runs the original query with the clauses wrapped around it, after a new estimate, **only** for a single
  SELECT run outside a session whose text the backend scanner finds deterministic (no `CURRENT_*`, `RAND`,
  `GENERATE_UUID`, `SESSION_USER`, temp tables or variables). Anything else (a script's child statement, a session
  query, a non-deterministic query) answers `REMOTE_EXPIRED` and offers Re-run. An
  `ORDER BY` that exceeds BigQuery's resources (`resourcesExceeded`) fails with a suggestion to filter first.
- Filters map to SQL per operation (equals, contains, starts with, ranges, null, value lists) with the same
  case and collation rules as BigQuery's `=` and `LIKE`, which the funnel says. Filters that name rows (`keepRows`,
  selection-based filters) are refused for windowed results with a tooltip.
- A funnel's value list is a `GROUP BY` over that column, capped at the funnel's existing limit.
- **Estimates.** `bigquery.dryRun` takes a `results.remoteQuery` request as well as editor text and answers bytes. The sort
  and filter controls show it, and the cost rules ([Cost](#cost)) apply. Each sort, filter and value list bills the
  bytes of the columns it scans.
- These queries run outside the tab's session (sessions forbid concurrent queries) through **`results.remoteQuery`**, a
  new stream method on the query lane with deadline 0, shaped like `query.execute`: it takes a `queryId`, its EVENT
  frames carry its own request id (`resultSet.opened`, `resultSet.residence`, `resultSet.closed`, the summary), and
  `query.cancel` with that id stops it and calls `jobs.cancel`. Its kinds are `view` (sort and filter), `distinct` (a
  value list, answered as a small in-memory result the funnel reads), `sample`, `load` (Load into memory) and `rerun`.
  For a remote result the renderer calls it instead of `results.view` and `results.distinct`, which answer
  `REMOTE_RESULT` if called. So no result slot is held for a job's run, and nothing needs an id-0 event.

**Disabled while windowed**, with a tooltip saying why and suggesting a filter or Load into memory: Pivot, Compare,
Column profile, the row-size bar (it needs a profile), Find in results, row highlights and row identities. Transpose shows its first `transpose.maxRows` rows,
which is already its rule.

- **Copy** of a selection reads its rows through the cache, within the existing Copy limits. A larger selection is
  refused with a pointer to Save. **Save Results As** streams the whole destination table (or the current view's) to the
  file through Storage Read (REST if that is off) and `ResultTextWriter`, never through the store. It has progress and
  Cancel, so the rows touch disk only in the file the user chose.
- **Load into memory** appears on a windowed result's toolbar when the projection fits the room free at that point.
- **Expiry:** once the destination table is gone, reads answer `REMOTE_EXPIRED`. The grid keeps cached blocks visible,
  marks the rest unavailable, and offers Re-run with the estimate. A cache hit's destination table is an older cached
  table, which may be near the end of its life or invalidated sooner, so a cache hit that would be windowed says
  "cached result: may expire early" in its caption; a test covers `REMOTE_EXPIRED` on the first read after a cache hit.
- **Invariant change** (docs/architecture.md, in BQ-3c-1): every backend reader of stored pages refuses a remote result
  with an error value (`REMOTE_RESULT`) before any work: sort, filter, profile, pivot, diff, search, row identity,
  distinct values and plan pairing; the renderer sends remote results' sort, filter and value lists to
  `results.remoteQuery` instead. `tests/result-page-access.test.ts` gets the case, and the working-memory lint covers
  the block cache.

### Other modes considered

- **Load a sample into memory** (0.10.0, small). On a windowed result: **Load sample…** with the first N rows (free,
  `tabledata.list`) or a random sample (`TABLESAMPLE SYSTEM`, which bills only the blocks it reads, after an estimate).
  It creates an in-memory derived result labelled "Sample: 1,000,000 of 52,341,118 rows", where pivot, compare and
  profile work. The label stays on everything built from it.
- **Pivot and profile pushed down to BigQuery** (0.11), as `GROUP BY` and `APPROX_*` queries.
- **Save to a BigQuery table** (0.11). A copy job turns the 24-hour table into a named one, so a result outlives the
  cache, can be shared, and can pass 10 GB. A console-style per-query destination table setting comes with it in 0.11
  (decision 50).
- **Statistics only** already exists: `discardResults` reads nothing back and still reports rows and bytes.

### Jobs, scripts, Stop

- **Execution:** a query job with `useLegacySql: false` (BigQuery's default is legacy), the default dataset, location,
  `maximumBytesBilled`, labels (`varia_client`), the BigQuery session, `maxRows` as today (rows read, not a `LIMIT`), and
  the execution timeout as `jobTimeoutMs`. Every query is created with `jobs.insert` and a
  client-generated `jobId`, so a request that may have reached Google is never sent twice as a new job: after a network
  error Varia asks `jobs.get` for that id, and a 409 on a retry means the job exists. (`jobs.query`'s `requestId` does
  not protect read-only queries and lasts only 15 minutes, so it is not used.) Varia then polls
  `jobs.getQueryResults`, whose first response also carries the first page. The job id and location go in Messages,
  so the user can find the job in the console.
- **Scripts:** a script runs as one parent job, and BigQuery returns only the last statement's rows. While it runs,
  Varia polls the child jobs (`jobs.list?parentJobId=`, bounded by `maxResultSets` plus Messages lines) and reads each
  finished `SELECT` child in statement order as result sets 1…n, so early results show before the script ends. DML and
  DDL children become Messages lines ("(1,204 rows affected)", "Table created."). There is no `GO`: the editor text goes
  up as one script, or the selection when there is one. Error positions `[line:column]` are mapped back to the editor,
  adding the selection's offset. Statements before a failing one have run and billed; Messages says so.
- **Stop:** `query.cancel` stops the fetch loop at once (the rows read so far stay, marked `incomplete`) and calls
  `jobs.cancel` on the parent job. Cancel is best-effort, so the message says BigQuery may still bill work done before
  it stopped. Inside a session, Stop is `jobs.cancel` only (`ABORT_SESSION` would end the whole session, temp tables,
  variables and transaction with it); the next execution polls the cancelled job until it is done before submitting.
### Re-attaching to jobs (BQ-3d)

A BigQuery job runs on Google's side whatever happens to Varia, and anyone signed in as the same principal can read it
again: `jobs.get` for its state, `jobs.getQueryResults` and the result table (kept about 24 hours) for its rows. So
Varia **re-attaches** to running jobs instead of cancelling them, as the BigQuery console does after a closed browser
tab (decision 51).

- **Job records.** Each `query.execute` and `results.remoteQuery` stream carries a `query.job` event (job id, location,
  project, parent or child, started or finished, and for session queries the BigQuery session id). Main keeps them in
  a small file of their own, `WorkbenchSession/jobs.json` (not the hot exit document, which is written only on close),
  with its own strict zod schema and limits (64 records per tab, 1,024 in all, bounded strings), written atomically on
  every `query.job` event whatever the hot exit setting, so a record survives a backend restart, a hot exit and a crash
  of the whole app. Each record is keyed to the tab's AutoRecover id, which already persists across restarts, and
  carries the profile id. At startup main pairs records with the restored tabs and drops records whose tab did not come
  back, after offering their cancel ([Fallback to cancel](#re-attaching-to-jobs-bq-3d)). Records older than the result
  table's lifetime (24 hours) are dropped. They hold no secrets and no SQL text: a job id or session id is useless
  without the principal's credentials. Finished jobs are dropped once their results are read.
- **When it happens.** Once a tab's connection is back (startup reconnect after a hot exit or crash, Reconnect after a
  backend restart or a network loss, or Reload Window), the renderer calls `query.attach` for each of the tab's jobs.
  A restored tab whose connection does not come back by itself (auto-reconnect off, or credentials refused) shows a line
  in Messages and the status bar: "BigQuery job … from the last session is still running: Reconnect to re-attach, or
  Cancel job" (the latter through `bigquery.cancelJobs`), so a running job is never unseen. `query.attach` is a stream method shaped like
  `query.execute` (query lane, deadline 0, `query.cancel` stops it) that takes a job reference instead of text. The backend keeps one attachment per job id: a second `query.attach` for
  a job already streaming (Reload Window while the old stream still polls, or two reconnect paths racing) takes over the
  existing stream rather than starting another. An attached session job holds the session's queue, so the next Execute
  waits for it as it would for any running session query. The backend first checks the connection's pinned principal is the one that created the job (`AUTH_IDENTITY` otherwise,
  and the job is left alone).
  - **Still running:** the tab shows the running state again ("Re-attached to job … started 12 minutes ago") and Stop
    works.
  - **Finished meanwhile:** its result sets are read from the result table (free) by the usual residence rule, and its
    summary and cost figures go to Messages.
  - **Scripts:** the parent job's children are listed again; finished statements' results and Messages lines are
    rebuilt in statement order, and polling continues for the rest.
  - **Sessions:** the BigQuery session lives on Google's side, so its temp tables and variables survive; the tab keeps
    using it while BigQuery accepts it, and otherwise starts a new one with the existing notice.
  - **Results gone** (expired, or a cache hit's table invalidated): the existing `REMOTE_EXPIRED` state with Re-run.
- Rows the old backend had read are not carried over; re-reading the result table costs nothing.
- **Quitting Varia leaves jobs running** and re-attaches at the next start, through hot exit's restored tabs. Today's
  close and quit prompt (`QueryService.confirmSessions` and `prepareSessions`, which offers to cancel executing queries
  and waits for them) changes for BigQuery: with hot exit on, quitting leaves BigQuery jobs out of it entirely (SQL
  Server queries still ask as today); with hot exit off there is no tab to restore, so BigQuery jobs join that prompt
  with the three choices below ("Don't quit" in place of "Don't close"). Jobs left running are excluded from
  `cancelPreparedSessions`.
- **Closing a tab or Close Results while a job runs asks first** (decision 52), through the same `prepareSessions`
  path, so a BigQuery tab sees one prompt, not two: **Cancel the job**, **Leave it running**, or **Don't close** (the default, and Escape). The dialog names the job,
  how long it has run and its estimate, and offers "Remember my choice" (`queryExecution.bigQuery.closeRunningJob`:
  `ask` by default, `cancel` or `leave`).
  - **Leave it running** detaches the job: Varia forgets it, and a notification shows its job id (with Copy) so the
    user can find it in the console. This suits long DML or `CREATE TABLE AS` jobs whose effect, not their rows, is the
    point. [Job history](#job-history-bq-9) lists such jobs. A tab whose session query is left running
    does not call `ABORT_SESSION`, which would kill the job; the session ends after 24 hours idle, and the dialog says
    its temp tables are billed as storage until then.
  - Windowed sort and filter queries and Load sample are auxiliary and never left running: closing their result cancels
    them without asking.
- **Fallback to cancel.** When a job cannot be re-attached because its tab did not come back or reconnect failed and
  the user closes the tab, main calls `bigquery.cancelJobs` (sensitive, carrying the profile's credential material, no
  connection handle). Deleting a profile that still has job records asks first: cancel its jobs, or keep the profile.
  Jobs that cannot be cancelled either are listed in a notification with their ids, for the console.

### Job history (BQ-9)

Job history covers the last thing a user would otherwise go back to BigQuery Studio for: seeing what ran, what is
running and what it cost, and cancelling it (decision 53). Studio has the same two views, Personal history and Project
history.

- **Opening it.** Each connection gets a **Job History** document tab. It opens from three places:
  - the connection's or the billing project's context menu in Object Explorer;
  - the command palette ("BigQuery: Job History");
  - the job id link in a BigQuery query tab's Messages. This opens the tab filtered to that job.

  There is one document per connection; opening it again focuses it.
- **Scope.**
  - **My jobs** is the default: the connection's principal.
  - **All users** lists the whole project (`allUsers=true`). `bigquery.jobs.list` (BigQuery User) is enough to list
    other users' jobs, but Google redacts their details. `bigquery.jobs.listAll` shows everything.
  - BigQuery has no call that answers "may I?" in advance. So Varia tries the call and turns `PERMISSION_DENIED` into a
    disabled toggle with an explanation, remembered for the connection. Redacted fields show as "hidden by BigQuery".
  - An extra project's history is not offered: jobs belong to the billing project.
- **Data.** Everything comes from `jobs.list`, which is free: an API call, not a query.
  - Always `projection=full`. Redaction happens server-side.
  - `minCreationTime` and `maxCreationTime` come from the time filter, bounded by BigQuery's 180-day retention.
  - Results come newest first, from every location. Locations that could not be read (`unreachable`) are named in the
    status line.
  - Never the `INFORMATION_SCHEMA.JOBS` views, which bill at least 10 MiB per query.
- **Refresh strategy.** `jobs.list` has no "changed since" filter, so each refresh asks for two things:
  - the jobs created after the newest one already held;
  - `stateFilter=pending,running` in the time range, to update the jobs that were still open.

  A job in DONE state never changes, so it is kept and never re-read. A full re-list happens only when the scope or
  filters change.
- **Live, through the existing live pipeline.** A new live scope `bigquery`, backed by a REST runner in the backend, and
  a source `bigquery.jobs` in `src/shared/live/catalog.ts` (`providers: ['bigquery']`).
  - The scope toggle and filters are its `liveArgsSchemas['bigquery.jobs']` entry; changing them is a `live.update`.
  - It is shown in a `LiveGrid` like Activity Monitor and Agent's Job Activity Monitor.
  - Probes gain an optional `idleIntervalMs` beside `intervalMs`. The backend uses `intervalMs` (5 s) while the last
    sample held a pending or running job, and `idleIntervalMs` (60 s) otherwise. Refreshes pause while the document is
    hidden, as live sources do today.
  - Refreshes go through the shared per-principal rate limiter. The renderer never polls.
- **Bounds.**
  - At most 1,000 jobs per view: the newest in the time range. The status line says when more exist and suggests a
    narrower range.
  - A 10 MiB response budget per refresh, within the live subscription's byte limit.
  - The grid carries a one-line SQL preview of at most 200 characters, never the full text.
  - Names and SQL are never logged.
- **Columns.**
  - State (running, pending, done, failed, cancelled) with the live grid's row tones (`tone-running`, `tone-error`, `tone-muted`).
  - Job id, type (query, load, extract, copy), and statement type (SELECT, INSERT, MERGE, CREATE_TABLE_AS_SELECT,
    SCRIPT, …).
  - User (all users only), created, duration, bytes processed, bytes billed, slot time, cache hit.
  - Location, destination table, error reason, SQL preview.
  - A "Varia" marker for jobs with the `varia_client` label.

  A script parent shows a chevron. `jobs.list` returns only top-level jobs, so its children are fetched when the user
  expands it or opens its details (`bigquery.jobs.get` with children), and re-fetched only while the parent runs.
- **Filters.** Filters cover:
  - state;
  - time range: last hour, 24 hours, 7 days, 30 days, or custom up to 180 days;
  - job type and statement type;
  - "Started from Varia";
  - text search over job id, user, destination and the SQL preview.
- **Details pane.** The pane fetches the job with `bigquery.jobs.get` when it opens and shows:
  - the full SQL in read-only Monaco with GoogleSQL highlighting, bounded by the existing `shownChars` rule;
  - configuration: dataset, location, caps, labels, session;
  - statistics: bytes, slot time, cache hit, rows affected, and the state timeline;
  - the error with its position;
  - the child jobs of a script.
- **Row actions.**
  - **Cancel job** on running and pending jobs. It asks first ("Cancel job … started by … 12 minutes ago?"), then
    calls `bigquery.jobs.cancel`. Cancelling another user's job needs `bigquery.jobs.update` on the project; a
    `PERMISSION_DENIED` disables the action for that connection, with the reason.
  - **Open results** for a finished query job of the principal's whose result table still exists (24 hours). It opens
    a query tab on the connection and re-attaches through `query.attach`
    ([Re-attaching to jobs](#re-attaching-to-jobs-bq-3d)), which is free. An expired result offers Re-run.
  - **Re-attach** to a running query job of the principal's: the same, showing it running in a new tab with Stop.
    Jobs a Varia tab already has attached focus that tab instead.
  - Open results and Re-attach are disabled for other users' jobs, with a tooltip: only a job's creator can read its
    result table.
  - **Open SQL in a new tab**, **Re-run** (after the cost rules), **Copy job id**, and **Copy console link** (the job's
    address in the BigQuery console, copied as text; Varia opens no browser).
- **Jobs left running** from a closed tab ([Re-attaching to jobs](#re-attaching-to-jobs-bq-3d)) are found here, with the
  "Varia" marker.
- **Methods:**
  - `bigquery.jobs.get` (unary, results lane, 30 s): one job's details, children and full SQL.
  - `bigquery.jobs.cancel` (unary, control lane, 30 s): one job. A write, so never a live probe.

  Both are scoped to a connection handle, take bounded job id (1,024) and location (64) strings, declare
  `providers: ['bigquery']`, and are added in all five places.
- **Not in 0.10.0:**
  - the query plan stages and timeline chart (Later);
  - details for load, extract and copy jobs beyond their statistics;
  - editing labels.

### Cost

Varia follows BigQuery Studio: the estimate is always visible, and nothing blocks by default (decision 22).

- Every summary reports bytes processed, bytes billed, cache hit, slot time and the job id, in Messages, and the bytes
  processed in the status bar beside the row count. Units are binary (KiB, MiB, GiB, TiB), as Google bills: on demand,
  per TiB, with a 10 MiB minimum per table referenced. The price is labelled an on-demand estimate, because projects
  with capacity (reservations) do not pay per byte.
- **Before execute:** a dry run (free) gives the estimate, shown in the status bar and Messages. Varia asks only in two
  cases:
  - **Above the threshold** (default 10 GiB): "This query will process 1.4 TiB (about $8.75 on demand). Run it?", with
    Run, Cancel, "Don't ask again for this connection" and a **Cost settings…** link.
  - **The estimate is incomplete**, the first time: a script stops the dry run at its first DDL or control statement,
    external and row-level-security tables report 0 bytes, and BigQuery can mark an estimate's accuracy `LOWER_BOUND` or `UNKNOWN`. The
    prompt says why the figure may be low, with Run, Cancel and "Don't warn me about incomplete estimates again", a
    global opt-out stored as `queryExecution.bigQuery.incompleteEstimateWarning`.
  - Both prompts open with focus on Cancel and are announced to screen readers.
- **Caps are the hard guard.** A global default on the Cost page (maximum bytes billed per query, empty by default)
  applies to every connection, and each connection can override it. The effective cap goes out as `maximumBytesBilled`
  with every job, so BigQuery fails the job, at no charge, past it. Whether a script's cap applies per statement or to
  the whole script is checked on the real project in BQ-3a and documented.
- Sort, filter, value lists, Load sample and Re-run go through the same estimate and prompts.
- **Options placement:** per-engine pages beside SQL Server's (`src/shared/settings/pages.ts`). **Text Editor ›
  GoogleSQL** (`textEditor.googleSql.*`): dry-run diagnostics and the opt-in bulk metadata path. **Query Execution ›
  BigQuery** (`queryExecution.bigQuery.*`): Cost (prompts, threshold, cap, price display) and Sessions. **Query Results
  › BigQuery** (`queryResults.bigQuery.*`): the residence, Storage Read and the window cache size.

### Sessions

- Each query tab gets a BigQuery session, created on its first execution (no extra charge). Temp tables, variables and
  `BEGIN TRANSACTION … COMMIT` then carry across executions, like a SQL Server tab's session. Closing the tab ends it
  (`CALL BQ.ABORT_SESSION()`).
- A session runs one query at a time, and BigQuery refuses a concurrent one rather than waiting. So every job that
  carries the session id (executions, session dry runs, `ABORT_SESSION`) goes through one backend queue per session.
  Execute cancels a pending diagnostics dry run and goes first. Dry runs that do not need the session (text that uses no
  temp tables or variables), windowed sort and filter, value lists and Preview Rows run outside it. BQ-3a-2 confirms on
  the real project that a dry run accepts a session id; if it does not, text that needs the session gets no estimate
  and the status bar says why. `ABORT_SESSION` runs only when the tab closes, and not when its running job is left
  running ([Re-attaching to jobs](#re-attaching-to-jobs-bq-3d)).
- `query.session.state` answers `transactionCount: 0` for BigQuery, so the close prompt never fires: BigQuery rolls back
  an abandoned session's transaction.
- A session ends after 24 hours idle or 7 days in all. When BigQuery reports it gone, the next execution starts a new
  one and Messages says that temp tables and variables were lost. The Sessions page says that temp tables in a session
  are billed as storage until it ends.
- Changing a tab to a dataset in another location starts a new session, so Varia asks first (decision 18).

### Types and display

Rows from REST are decoded from the `TableRow` JSON by Varia's own converter, not `BigQueryRow`: the client throws on
`RANGE` and `INTERVAL`, and its converter would format values and use memory outside the budget's accounting. Arrow
batches are decoded by `ArrowColumnPlan` to the same text.

| GoogleSQL | Cell | Display |
| --- | --- | --- |
| INT64, NUMERIC, BIGNUMERIC, BOOL | text | Invariant culture, full precision (BIGNUMERIC to 38 scale digits), `true`/`false` |
| FLOAT64 | text | Shortest round-trip text; `NaN`, `Infinity`, `-Infinity` as BigQuery writes them |
| STRING | text | As is, with existing cell-length truncation |
| BYTES | binary | `0x…` as today |
| DATE, TIME, DATETIME | text | ISO 8601, fractional seconds as stored |
| TIMESTAMP | text | UTC, fixed width: `2026-11-15 09:30:00.000000 UTC` (decision 14) |
| INTERVAL, RANGE | text | BigQuery's canonical text (`1-2 3 4:5:6`, `[2024-01-01, 2024-02-01)`) |
| GEOGRAPHY | text | WKT |
| JSON | text, role `json` | Open Value opens the JSON viewer |
| STRUCT, ARRAY | text, role `json` | Compact JSON text, so a cell stays one cell. Open Value shows it formatted |

Flattening nested columns into grid columns is not planned (BigQuery's console does not do it either).

## 3. Query support

### GoogleSQL in Monaco (BQ-4)

- A new Monaco language, `googlesql`, with its own Monarch tokenizer. It covers backtick identifiers with dots and
  dashes (`` `my-proj.ds.table` ``), `r`/`b`/`rb` prefixes, triple-quoted strings, `#` and `--` and `/* */` comments,
  `@param` and `@@system_variable`, `STRUCT<…>`/`ARRAY<…>`, and GoogleSQL's keywords and reserved words. Brackets and
  auto-closing pairs come from a language configuration.
- **The document kind stays `sql`.** A query document gains `provider` and its Monaco language follows it, so
  `isQueryDocument` and its call sites do not change. The tab caption shows "GoogleSQL" or "Transact-SQL". Changing a
  tab's connection to another provider switches the model's language and clears its markers, and the editor says so,
  since the SQL is unlikely to run as is. No automatic dry run follows a provider switch or a restore until the user
  edits or executes, so existing T-SQL (which may hold a `CREATE LOGIN … PASSWORD`) is never sent to Google unasked. Hot exit and AutoRecover save `provider` with the tab (the session file's
  version 3); a tab restored without its connection keeps its language.
- Keyword and function lists are a generated catalogue (`src/shared/googlesql/catalog.ts`: functions with signatures
  and one-line descriptions) with a regenerate test, following the other catalogues, and a row in CLAUDE.md's generated
  files table.

### Search Objects for BigQuery (BQ-6a)

The index is the single metadata source, so one BigQuery index serves Search Objects, the header's Search (Ctrl+Q) and
IntelliSense. As for SQL Server, it is one index per connection, in backend memory only, under the shared 512 MiB
`IndexBudget`, and dropped on disconnect.

**Free REST calls are enough. The indexer does not need `INFORMATION_SCHEMA`.** It builds in two passes, so names are
searchable within seconds and details fill in behind them:

1. **Names:** `datasets.list` for each project, then `tables.list`, `routines.list` and `models.list` for each dataset:
   every object's name, kind (table, view, materialized view, external, snapshot, clone), creation and modified times,
   and labels. Date-sharded tables (`events_20260101`, `events_20260102`, …) are grouped into one entry with their
   shard range, as the console does.
2. **Details:** `tables.get` for each table (one per sharded group: its newest shard): columns with types, descriptions
   and nested STRUCT fields, partitioning, clustering, row count and size, and view text. `routines.get` gives a
   routine's arguments, return type and body. Extra projects get pass 1 only by default (`textEditor.googleSql.indexExtraProjects`),
   since a public project can hold tens of thousands of tables.

What REST costs is time, not money: one `tables.get` per table, within BigQuery's 100 requests a second per user and
method. One rate limiter per principal is shared by the index, Explorer, Preview Rows and pickers, capped below that
(16 in flight), so 10,000 tables take about two minutes for pass 2 while names are already searchable. **Refresh:**
Explorer's Refresh on a node and Search Objects' Refresh re-list that scope and re-read only objects whose
`lastModifiedTime` changed; DDL run from a tab marks its dataset stale. The optional bulk path (off by default) replaces
pass 2 with region-scoped `INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` (plus `ROUTINES`, `VIEWS`) queries, each billing at
least 10 MiB and never cached, after the cost rules.

Search Objects enhancements this needs (in BQ-6a, with the index's limits mirrored in C#):

- Index entries carry the scope `project` › `dataset` › `name` in place of `database` › `schema` › `name`, with
  BigQuery's lengths: dataset and table names up to 1,024 UTF-8 bytes, column names and nested paths up to 300 per
  part. BQ-6a owns the index DTO's scope and column-type fields.
- Kind filters list the BigQuery kinds (table, view, materialized view, external table, snapshot, clone, routine,
  procedure, table function, model), shown only for BigQuery connections.
- Name search covers project, dataset and object names. Definition search covers view and materialized view text and
  routine bodies. Column search covers column names and nested field paths (`address.city`), with the column's type.
- The details pane shows the schema, partitioning and clustering, rows, size, labels and the view or routine text,
  paged by the existing `shownChars` rule.
- Result actions: Locate in Object Explorer, Preview Rows (tables only), Script As, copy the backtick-quoted full name,
  and open a new query on the object's connection.
- "All servers" search spans SQL Server and BigQuery connections together. Each result row shows its provider and
  connection.
- Progress, partial results and per-dataset failures use the existing build status and skipped values, worded for
  datasets. `explorer.index` builds the BigQuery index through the same method, routed by provider.
- Never log names, definitions or search text (the existing rule).

### IntelliSense from the index (BQ-6b)

- Completion is Varia's own, from the index, with no language server: keywords and functions (signature help comes from BQ-4's catalogue), then
  projects, datasets, tables and columns. A light GoogleSQL scope reader resolves `FROM`/`JOIN` aliases and `WITH` names
  to columns. This is the "own completion from the index" stage of the query-editor direction, built for BigQuery first,
  and it needs the index's planned column-type metadata (stage 1 of that direction: **Shared** with the editor work).
- Hover: a table's schema summary (columns, types, partitioning, row count, size) and a column's type and description.
- Diagnostics (BQ-7, through `language.diagnostics` routed to the GoogleSQL provider): a dry run after an editing pause (1 s, one in flight per document, latest wins) gives the
  syntax and binding error with its `[line:column]`, mapped to a marker, and the estimate in the status bar ("This query
  will process 1.2 GiB"), as BigQuery Studio does. A dry run sends the editor text to Google, so it runs only on a
  connected BigQuery tab and a setting turns it off; docs/architecture.md records this as the one path that automatically, without a user action, sends
  unexecuted text off the machine. Text that uses the session's temp tables is dry-run through the session's queue, or gets no estimate if BigQuery
  refuses session dry runs ([Sessions](#sessions)).

### Script As and actions (BQ-5)

| Action | BigQuery equivalent |
| --- | --- |
| Select Top 1000 Rows | **Preview Rows**, for tables, snapshots and clones: the first 1,000 rows through `tabledata.list`, free, into an in-memory result (no remote sort). Views, materialized views and external tables have no stored rows to list, so the menu offers Script As SELECT instead. A table with row access policies answers `ROW_ACCESS` with the same offer |
| Script As SELECT | `SELECT col, … FROM \`p.d.t\` LIMIT 1000;` in a new tab, with a comment that LIMIT bills the columns scanned (clustering can reduce it) |
| Script As CREATE | The `ddl` column of `INFORMATION_SCHEMA.TABLES`/`ROUTINES`: one query, about 10 MiB billed, after the cost rules, the user's action |
| Script As INSERT, UPDATE, DELETE, DROP | Templates built locally from the schema; nothing runs |
| Go To Definition / Peek | Views' and routines' text from `tables.get`/`routines.get` into Peek (0.10.0 if time allows; otherwise Later) |
| Properties | A read-only facts document tab (`tables.get`: type, partitioning, clustering, expiration, labels, size, rows) |
| Rename, Delete, Table Designer, object actions | Not in 0.10.0 |

Object Explorer: catalogue kinds (project, dataset, tables, views, materialized views, external tables, snapshots,
routines, models; nested columns) with `project`/`dataset` scope fields and the identifier lengths above, listed with
REST through the shared rate limiter. Explorer chips are SQL Server-only.

## 4. Architecture fit

### Backend

- New folder `backend/Varia.Backend/BigQuery/` with `BigQueryService`, which owns BigQuery connections (credential,
  `BigQueryClient`, pinned principal, tab sessions, in-flight jobs) in a registry keyed by the same handle ids as SQL
  Server connections. `SqlService` keeps its SQL Server dictionaries. Provider-neutral methods route by the handle's
  provider after the provider check.
- **Rows:** `ColumnPlan` becomes an interface over a reader. `SqlColumnPlan` is today's code. `BigQueryColumnPlan`
  (REST) and `ArrowColumnPlan` write into `PageBuilder`. `ResultSetBuffer`, budgets, packing and every reader after the
  store are unchanged apart from `sortKind`.

**Methods.** Every existing method keeps its meaning or answers `UNSUPPORTED_PROVIDER` for a BigQuery handle:

| Method | BigQuery |
| --- | --- |
| `connections.connect`, `connections.disconnect` | The union; BigQuery connect resolves credentials, pins identity, runs the probe |
| `connections.databases`, `databases.list` | Datasets of the billing project, with locations |
| `connections.identity`, `connections.preview` | Principal and project; the dialog's preview of what will be connected |
| `query.execute` | Gains optional `dataset` (1,024 bytes). Today's `sessionId` stays Varia's tab id; the backend keeps the BigQuery session keyed by it and never sends BigQuery's session id over IPC. SQL Server-only fields (`includeActualPlan`, `includeLivePlan`, `includeClientStatistics`, `stopOnError`) refused in main and in C# |
| `query.cancel`, `query.session.close`, `query.session.state` | `jobs.cancel` (plus session abort); `ABORT_SESSION`; `transactionCount: 0` |
| `results.*` | Unchanged for in-memory results. For remote results: `read`, `rowBytes`, `rowIds` through the cache; `copy` and `export` streaming; `viewClose`, `distinctClose`, `close`, `visibility`, `setMemoryLimit` as today (for derived results too); `view`, `distinct`, `distinctRead`, `distinctTick`, `pivot`, `profile`, `diff`, `search`, `findRows`, `identify` answer `REMOTE_RESULT`, and remote sort, filter and value lists go through `results.remoteQuery` |
| `live.subscribe`, `live.update` | The `bigquery.jobs` source (job history) in the new `bigquery` live scope; SQL Server's sources answer `UNSUPPORTED_PROVIDER` |
| `explorer.children`, `explorer.index`, `explorer.search` | REST listers and the BigQuery index |
| `explorer.peek`, `explorer.peekDefinition`, `language.definition` | View and routine text (if Peek ships) |
| `tables.columns` | Columns from `tables.get` |
| `scripting.script` | Script As CREATE (query) and local templates |
| `language.*` | Routed to the GoogleSQL provider (completion and hover from the index; `language.diagnostics` dry-runs) |
| `actions.*`, `activity.*`, `ssis.*`, `plans.*`, `explorer.dependencies`, `explorer.peekDependencies`, `connections.discover`, `entra.cache.clear` | `UNSUPPORTED_PROVIDER` |

New methods, each in all five places with bounded strings: `bigquery.account` and `bigquery.projects` (pre-connect,
sensitive), `bigquery.dryRun` (the estimate before execute and for views), `bigquery.preview` (Preview Rows),
`bigquery.cancelJobs` (the fallback when re-attaching is impossible, sensitive), `query.attach`,
`bigquery.jobs.get`, `bigquery.jobs.cancel` (job history) and `results.remoteQuery`. New event types in existing
query streams: `resultSet.residence` and `query.job`. New main-only IPC channel: `connections.pickKeyFile`. All new
methods declare `providers: ['bigquery']`. The protocol stays v2: new methods, new event types inside existing streams
and optional descriptor fields are all additive (docs/ipc.md records each).

| New method | Kind | Lane | Deadline |
| --- | --- | --- | --- |
| `bigquery.account`, `bigquery.projects` | unary, sensitive | control | 30 s |
| `bigquery.dryRun` | unary | control | 30 s |
| `bigquery.preview` | unary | results | 120 s |
| `bigquery.cancelJobs` | unary, sensitive | control | 30 s |
| `bigquery.jobs.get` | unary | results | 30 s |
| `bigquery.jobs.cancel` | unary | control | 30 s |
| `results.remoteQuery` | stream | query | 0 (until done or cancelled) |
| `query.attach` | stream | query | 0 (until done or cancelled) |

**SQL the backend runs.** Constant text in `BigQuery/BigQuerySql.cs`, values as query parameters. BigQuery cannot take
identifiers as parameters and has no `QUOTENAME`, so names go in only through `BqNames`, with one quoting function per kind (project, dataset, table, column), each
validating that kind's rule and length ([Provider in the connection model](#provider-in-the-connection-model-bq-0-shared)),
escaping backticks and backslashes, and backtick-quoting. The lint has hostile cases per kind, flexible column names
included. This is an **invariant change**: today's rule says
names only through server-side `QUOTENAME`; docs/architecture.md and CLAUDE.md gain "or, for BigQuery, `BqNames.Quote`".
The paths, all under one offline lint that renders every template with hostile names:

| Path | SQL |
| --- | --- |
| Connect probe | `SELECT 1` dry run |
| Windowed sort, filter, value lists | `SELECT * FROM dest WHERE … ORDER BY …`, `GROUP BY` |
| Load sample | `TABLESAMPLE SYSTEM` |
| View estimates | Dry runs of the above |
| Sessions | `CALL BQ.ABORT_SESSION()` |
| Script As CREATE | `INFORMATION_SCHEMA.TABLES`/`ROUTINES` `ddl` |
| Bulk index (opt-in) | `INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`, `ROUTINES`, `VIEWS` |

**Bounds.** HTTP requests have deadlines inside each method's deadline. Response bodies are read into the budget (one
page ahead at most). Dry-run and metadata calls share the per-principal limiter. A 429 or 5xx gets bounded retries for
idempotent reads; a job is never re-created, only looked up by its client-generated `jobId` (`jobs.get`).
Identifier inputs take BigQuery's lengths (1,024 UTF-8 bytes for datasets and tables, 300 characters for columns) in zod and C#, on the
BigQuery branches only, so SQL Server's 128 stays. Never log SQL, names, values, tokens or keys; the Google libraries'
own logging stays off.

**Packages:** `Google.Cloud.BigQuery.V2` 3.12 (REST), `Google.Apis.Auth`, `Google.Cloud.BigQuery.Storage.V1` (gRPC
through Grpc.Net.Client) and `Apache.Arrow`. The backend is ReadyToRun, not trimmed or AOT, so they fit. BQ-1 records
the installer size growth and does the license and notice review.

**Proxies** (decision 19): REST and gRPC use the system proxy and certificate store. On Windows and macOS that is the OS
setting; on Linux, .NET reads only `HTTPS_PROXY`/`NO_PROXY`. Apps started from a macOS or Linux desktop do not inherit
a shell's environment, which docs/bigquery.md explains. gRPC through an HTTP proxy uses CONNECT; BQ-3b checks it.

### Renderer and main

- `ConnectionService` and the target registry carry the provider. `connection-open.ts` resolves credentials per
  provider (main reads key and config files for BigQuery).
- Query tabs: the database dropdown becomes a dataset dropdown for BigQuery. The status bar shows the principal and
  project instead of `login (spid)`, plus bytes processed.
- **Hidden or disabled for BigQuery** (through `providers`, not ad hoc checks): Activity Monitor; SSIS; SQL Server
  Agent (**Shared**); Table Designer; object actions; actual, estimated and live plans; client statistics;
  `sp_help`/`sp_who`/`sp_lock` templates; ScriptDom Go To Definition; named result set markers (`#Name=`); Registered
  Servers' instance browse; Explorer status chips; transaction prompts on close; Encrypt and TLS options; SQLCMD.
- Results, grid, Copy and Save, popouts, hot exit and AutoRecover work with the changes above (provider on the tab,
  residence and revision on result sets).
- **Accessibility:** the cost prompts take focus on Cancel; residence changes, window fetch waits and session restarts
  are announced through the existing live region; smoke asserts each.

## 5. Testing

| Layer | What | Runs |
| --- | --- | --- |
| Offline .NET | A fake BigQuery HTTP handler injected through `BigQueryClientBuilder`, replaying recorded REST JSON: paging, the residence decision and the switch to windowed, byte-sized blocks, read-ahead per viewer, the fetch lane, remote sort and filter SQL and the fallback to the original query, `REMOTE_RESULT` on every page reader, `REMOTE_EXPIRED`, the row cap, every error row in [Errors](#errors), child-job scripts with incremental polling and `[l:c]` with selection offsets, client `jobId` lookup after a network error and the 409 path, cancel, job records and `query.attach` in every state (running, finished, script, session, expired, other principal), the `bigquery.cancelJobs` fallback, `jobs.list` paging, scopes, the two-part refresh, DONE jobs never re-read, idle and active intervals, bounds, redacted fields, lazy children, `bigquery.jobs.get` and `bigquery.jobs.cancel` with permission refusals, every type in both REST and Arrow (the golden test), `sortKind` parity for SQL Server, identity pins per mode, every accepted and refused federation shape, key file checks, `BqNames` and the SQL lint, the provider check in `DispatchAsync` | `npm run check`, every PR |
| vitest | Tokenizer golden files, completion and alias scope, both `providers` lints and the main-side method check, the principal union with the old spelling, migration of every 0.9.0 file, dialog form logic (type switch, Undo, pickers), the cost-prompt rules (threshold, incomplete estimate, both opt-outs), the location prompt (decision 18), the close prompt's three choices and remembered setting (decision 52), quitting with hot exit on and off, a restored tab that does not reconnect, a second attach, deleting a profile with job records, records older than 24 hours, the 10 GiB threshold units | `npm run check` |
| Smoke | The connect dialog's BigQuery path, Explorer browse, execute and stream, a windowed result under **Always windowed** (scroll, jump, sort, filter, expiry), Stop, the cost prompts, Job History (open, filter, cancel, open results), hidden SQL Server commands, focus and announcements. Against the emulator via `VARIA_TEST_BIGQUERY_ENDPOINT`; skips when unset | An existing Linux smoke shard |
| Emulator live | `ghcr.io/goccy/bigquery-emulator` 0.8.x (pinned by digest) as a service container: queries, paging, scripts, parameters, cancel, types, REST metadata, and Storage Read (its plaintext gRPC port, 9060, through an insecure HTTP/2 channel in test builds only). Emulator mode uses anonymous credentials, skips the probe and sessions, and fakes estimates. It does not cover sessions, dry runs, transactions, bytes statistics, routines beyond insert, or INFORMATION_SCHEMA; those stay on the fakes and the real project. BQ-1 confirms the .NET client works against it first | Folded into an existing Linux live group, not a new job; seconds recorded in docs/ci.md |
| Real project (opt-in) | `VARIA_TEST_BIGQUERY_PROJECT` plus ADC or `VARIA_TEST_BIGQUERY_KEY_FILE`. Public datasets and one scratch dataset with a 1-day expiration. It proves sessions, dry runs, cost figures, child jobs, identity pinning, the per-statement cap question and Storage Read pricing. **Spending rules:** every job sends `maximumBytesBilled` of 100 MiB (the suite fails a job that does not), every check dry-runs first and skips above its allowance, a run stops after 1 GiB billed in total, queries touch only small public tables and the scratch dataset, the Storage Read check reads one small result, and the run asserts and prints `totalBytesBilled`. Recorded fixtures for the offline fakes are refreshed from this suite at release preparation | Local only, no repository secret (decided) |

**Test-project hygiene** (docs/testing.md): before the first run, set a custom "Query usage per day" quota of 10–50 GiB
on the project and a budget alert; budgets only alert, the quota is what stops spending. The free tier (1 TiB of
queries a month) covers the suite many times over. A sandbox project cannot run DML, so the scratch checks need billing
enabled. Neither the daily query quota nor `maximumBytesBilled` limits Storage Read bytes or session temp-table
storage, so the suite reads one small result and ends its sessions. Benchmarks for Storage Read throughput run offline against the fake or locally, never against the real
project in CI.

## 6. PR lanes

Sizes: S under a day, M a few days, L about a week. Lanes on the same row of the order can run in parallel. Each lane
updates the docs it changes; the Docs column names the ones beyond its area page, docs/bigquery.md (new in BQ-1) and
CHANGELOG.md's Unreleased summary, which every lane updates.

| Lane | Contents | Size | After | Docs |
| --- | --- | --- | --- | --- |
| **BQ-0** Provider foundation (**Shared**) | One `ProviderId` and the principal union; connection-options union; per-provider files and the startup migration; per-provider keys, bindings, pin and seal; `activeDocumentProvider`/`explorerProvider`; catalogue `providers` (default `['sqlserver']`, both engines declared on neutral entries) and its lint; provider context keys;
error codes in their enums; tab, AutoRecover and target records; method `providers` checked in main and `DispatchAsync`; `UNSUPPORTED_PROVIDER`; the `sortKind` factory with SQL Server parity. No BigQuery behaviour | L | — | architecture.md, ipc.md, generated catalogue docs |
| **BQ-1** Backend engine and connect | Packages, size and license check; `BigQueryService` and registry; ADC, key file, federation (pinned shapes), impersonation; identity pins; error taxonomy; connect probe (dry run) and disconnect; pre-connect methods; fake HTTP handler; emulator check, emulator mode and its live group | L | BQ-0 | testing.md, ci.md, bigquery.md |
| **BQ-4** GoogleSQL editor | `googlesql` language and tokenizer; provider on query documents; language switch on connection change; keyword and function catalogue with signature help | M | BQ-0 | CLAUDE.md generated-files row |
| **BQ-2** Connect dialog and saved connections | Server type with Undo; BigQuery fields; account line; key file picker through main; both project pickers and the dataset picker; saved connections, MRU and labels by project; query tab dataset dropdown and status bar | M | BQ-1 | README, settings and icons regenerated |
| **BQ-3a** Execution | `jobs.insert` with a client `jobId` (`useLegacySql`, lookup after a network error, 409 means it exists) and `jobs.getQueryResults` polling; REST reads into memory (`BigQueryColumnPlan`, converter, types); truncation as SQL Server; cost figures and units; the per-statement cap check | L | BQ-1 | ipc.md |
| **BQ-3a-2** Scripts, sessions, Stop | Child jobs with incremental polling and `[l:c]`; tab sessions, expiry, location prompt; Stop; the `query.job` event | M | BQ-3a, BQ-2 (the location prompt sits on its dataset dropdown) | |
| **BQ-3d** Re-attaching to jobs | Job records in `WorkbenchSession/jobs.json`; `query.attach` (running, finished, scripts, sessions, expired); identity check; quit behaviour with and without hot exit; the close prompt and its setting; Leave running; the `bigquery.cancelJobs` fallback | M | BQ-3a-2, BQ-3c-1 (finished results may be windowed), BQ-7 (the dialog shows the estimate; the setting sits on its pages) | README, settings regenerated |
| **BQ-3b** Storage Read in memory | Storage Read (Arrow), stream order by the backend scanner, REST fallback and messages, the REST/Arrow golden test, pricing check, proxy check, offline throughput benchmark | M | BQ-3a | testing.md |
| **BQ-7** Dry run and cost | `bigquery.dryRun`; the estimate before execute, both prompts and opt-outs; status bar estimate; diagnostics markers; Cost and Sessions settings pages | M | BQ-3a, BQ-4 | settings regenerated, architecture.md (dry runs send text) |
| **BQ-3c-1** Remote results | Residence decision and setting; remote result; byte-sized block cache, read-ahead per viewer, fetch lane; `results.read` waits; `revision` and the residence event; row cap; Memory panel; invariant change and page-access and working-memory lints; misestimate switch; `results.remoteQuery` (all five places, kinds enum, events, cancel path, ipc.md entry) with the `load` kind | L | BQ-3b | architecture.md, ipc.md |
| **BQ-3c-2** Remote views | Derived remote results for sort and filter; value lists; filter mapping and refusals; fallback to the original query; view estimates through `bigquery.dryRun`; the `view` and `distinct` kinds; disabled features and tooltips | M | BQ-3c-1, BQ-7 | |
| **BQ-3c-3** Copy, Save and loading | Copy limits; streaming Save; Load into memory UI; Load sample and Re-run (the `sample` and `rerun` kinds); `REMOTE_EXPIRED` UI | M | BQ-3c-1, BQ-7 (sample and Re-run are billed) | README |
| **BQ-5** Object Explorer | Catalogue kinds and scope fields; REST listers and shared rate limiter; Preview Rows; Script As; Properties facts | M | BQ-3a (Preview Rows reads through its converter), BQ-7 (Script As CREATE is billed); AG-1 first or rebase | generated Explorer and Script As docs |
| **BQ-6a** Search Objects index | Two-pass REST index (sharded groups, extra projects by name, refresh triggers); index DTO scope and column types; optional billed bulk path; Search Objects scope, kinds, searches, details, actions, All servers | M–L | BQ-1, BQ-5 (BQ-7 for the billed bulk path) | |
| **BQ-6b** IntelliSense | Completion from the index with alias scope; hover | L | BQ-4, BQ-6a, and the index's column metadata from the editor plan | |
| **BQ-9** Job history | `bigquery` live scope and REST runner; `bigquery.jobs` source, args schema and `idleIntervalMs`; `bigquery.jobs.get` and `bigquery.jobs.cancel`; Job History document with `LiveGrid`, scope toggle, filters, script grouping, details pane; Cancel job, Open results, Re-attach, Open SQL, Re-run, Copy job id and console link; entry points in Explorer, palette and status bar | M | BQ-3d (Open results and Re-attach), BQ-5 (Explorer menus), BQ-7 (Re-run's cost rules) | live catalogue docs regenerated, README |
| **BQ-8** Live checks and docs | Real-project opt-in suite and fixture refresh; windowed smoke; Getting Started guide and sample (`src/shared/help/catalog.ts`); final docs pass | M | lands alongside each lane; final pass last | README, testing.md, help |

Critical path: BQ-0 → BQ-1 → BQ-3a → BQ-3b → BQ-3c-1 → BQ-3c-2, with BQ-2 (needed to try anything in the app), BQ-7,
BQ-3a-2, BQ-3d and BQ-9 beside it, and BQ-5 → BQ-6a → BQ-6b on a second track. BQ-0 first also gives Agent its gating. If the
release is tight, BQ-6b's completion can ship with objects and keywords only (no alias scope), and Load sample, Peek
and Properties can move to 0.11 without hurting the core experience.

## Later

- Browser OAuth sign-in with a Varia-owned Google client (needs Google's verification) and refresh tokens in
  `safeStorage`.
- Pivot and profile pushed down to BigQuery for windowed results, and Save to a BigQuery table plus a per-query
  destination table setting (lift the 10 GB limit).
- Execution details: BigQuery's query plan stages and timeline in the plan canvas.
- A parameters prompt for undeclared `@names`, batch query priority, a local-time TIMESTAMP option, and a custom API
  endpoint in the UI.
- Table actions (delete, copy, expiration, labels), dataset creation, the external-account `executable` source behind
  an explicit opt-in.
- Deleting the frozen 0.9.0 files (`connections.json`, `saved-passwords.json`, `Session/`, `AutoRecover/`).

## Decisions

Recorded on 2026-11-15, from the owner's answers to the draft's open questions.

1. **Auth in 0.10.0:** gcloud credentials (ADC), service account key, Workforce/Workload Identity Federation and
   impersonation. Browser sign-in waits until a Varia Google OAuth client is verified (0.11 or later).
2. **Key files:** a saved connection remembers the key file's path, not its contents.
3. **Cost guard:** no hard cap by default. **Caps must be configurable:** a global default in Tools › Options › Query
   Execution › BigQuery › Cost plus a per-connection override, with the threshold and switches on the same page. The
   prompts link to that page. (Revised by decision 22: the estimate is always shown, and Varia asks only above the 10 GiB
   threshold or the first time an estimate is incomplete.)
4. **Sessions:** a BigQuery session per query tab, on by default.
5. **Metadata:** the Search Objects index and IntelliSense use free REST calls. The billed `INFORMATION_SCHEMA` bulk path
   is opt-in.
6. **Live tests:** the emulator runs in CI. Real-project checks stay local and opt-in, with no repository secret.
7. **Plan location:** this page, landed as a docs-only PR.
8. **Results:** in memory or windowed, as [section 2](#2-results-in-memory-or-windowed) describes, at the owner's
   request: the half-of-budget projection, a 64 MiB block cache, switching to windowed on a misestimate, windowed sort
   and filter going through the cost rules, and Load sample in 0.10.0. Pivot and profile pushed down, and Save to a
   BigQuery table, are 0.11. (Blocks are now sized by bytes: decision 30.)

Recorded on 2026-11-15, from the owner's answers to the mock review's questions (all agreed as recommended).

9. **Test project:** the owner has a free-trial project for the opt-in real-project checks. Its credits are limited, so
   those checks keep to the spending rules in [Testing](#5-testing). The project id stays out of the repository; it goes
   in `VARIA_TEST_BIGQUERY_PROJECT` locally.
10. **Query parameters:** 0.10.0 relies on `DECLARE`/`SET` in scripts. A prompt for undeclared `@names` is later.
11. **Batch priority:** not in 0.10.0.
12. **Price in estimates:** bytes are always shown. The price is on by default at the US on-demand rate, with one
    switch on the Cost page; there is no per-connection rate.
13. **Legacy SQL:** refused with a clear message (a `#legacySQL` prefix or a legacy-only error); GoogleSQL only.
14. **TIMESTAMP display:** UTC, as the BigQuery console shows it. A local-time option is later.
15. **Custom API endpoint:** not in the 0.10.0 UI. (Revised in the review: the emulator endpoint is an environment
    variable read only by unpackaged builds, with anonymous credentials, so no setting can send a Google token to
    another host.)
16. **Installer size:** the estimated 15–25 MB growth is acceptable; BQ-1 measures it.
17. **Provider icon:** a generic custom icon (a hexagon with a magnifier, drawn on Varia's icon grid), not Google's logo.
18. **Sessions and location:** switching a tab to a dataset in another location starts a new session, so Varia asks
    first, as SQL Server's transaction prompt does.
19. **Proxies:** REST and the gRPC Storage Read path use the system proxy and certificate store; the docs get a proxy
    note per platform.
20. **Getting Started:** a "Connect to BigQuery" guide and a windowed-results sample, in BQ-8.

Recorded on 2026-11-15, from the owner's answers to the adversarial review's questions.

21. **Large results:** windowed results accept BigQuery's 10 GB limit on anonymous result tables, which the BigQuery
    console shares (its workaround is a named destination table). Larger results fail with `RESULT_TOO_LARGE` and a
    suggestion; Save to a BigQuery table lifts the limit later.
22. **Cost behaviour:** like BigQuery Studio, the estimate is always visible and nothing blocks by default. Varia asks
    above the threshold (10 GiB, with a per-connection opt-out) and, the first time, when an estimate is incomplete,
    with a global opt-out. No default cap.
23. **Federation:** only Google's exact STS and IAM credentials endpoints, file sources read by main, and AWS and Azure
    sources at their exact documented metadata URLs. Any other host and executable sources are refused.
24. **Downgrade safety:** per-provider connection files and new session and recovery file names, migrated at startup.
    The 0.9.0 files are left untouched as a frozen snapshot, deleted in a later release.

Recorded on 2026-11-15: details the adversarial review settled within the agreed scope.

25. **File names:** `mssql-connections.json`, `bigquery-connections.json`, `mssql-saved-passwords.json`,
    `WorkbenchSession/`, `WorkbenchAutoRecover/`.
26. **Document kind:** query documents stay kind `sql` with a `provider`, rather than a second kind.
27. **Catalogue gating:** `providers` defaults to `['sqlserver']` for catalogue entries and methods alike; entries that
    work for both engines declare it. This matches docs/agent-plan.md, so Agent's entries need nothing. AG-1 and BQ-5
    both extend the Explorer catalogue and Search Objects kinds: land AG-1 first or rebase whichever is second.
28. **Column types:** an engine-neutral `sortKind` on result columns, with SQL Server parity tests.
29. **Identifier limits:** BigQuery's lengths apply on BigQuery branches only; descriptors keep 4,096 columns and
    256-character type text, truncated with a note.
30. **Window blocks:** sized by bytes (about 4 MiB, 256–16,384 rows), on a fetch lane of their own, read ahead per
    viewer.
31. **Row cap:** windowed results show at most 2,147,483,647 rows, with an explicit truncation note.
32. **Remote views:** sort and filter create derived results that start at once and stream like a query, fall back to
    the original query only for a deterministic single SELECT outside a session, and refuse row-named filters.
33. **Orphaned jobs:** superseded by decisions 51 and 52 (re-attach, and a prompt on close).
34. **Job creation:** every query is a `jobs.insert` with a client-generated `jobId`, looked up after a network error
    and never re-created; no inline (job-less) queries.
35. **Sessions:** auxiliary queries run outside the tab's session; an expired session is replaced with a notice.
36. **Preview Rows:** tables, snapshots and clones only; views use Script As SELECT.
37. **Index scope:** date-sharded tables grouped; extra projects indexed by name only by default; one rate limiter per
    principal.
38. **Pre-connect methods:** `bigquery.account` and `bigquery.projects` are sensitive, with main injecting credentials.
39. **CI:** no new jobs: the emulator joins an existing live group and smoke shard.
40. **Test endpoint:** `VARIA_TEST_BIGQUERY_ENDPOINT`, unpackaged builds only, anonymous credentials.

Recorded on 2026-11-15: details the second review round settled within the agreed scope.

41. **ADC is validated:** the ADC file goes through the same typed loads and URL pins as the explicit modes; rotating
    file sources are re-read through main on every token exchange.
42. **Session Stop:** Stop cancels the job only; `ABORT_SESSION` runs only on tab close; every job carrying the session
    id goes through one queue per session, Execute first.
48. **Credential URL pins for every type:** `universe_domain` must be `googleapis.com`, and `token_uri`, impersonation
    URLs and nested `source_credentials` URLs are pinned to Google's endpoints for every credential type, with a
    refused-shape test for each.
49. **Federation file sources are confirmed:** the first use of a config shows the resolved `credential_source.file`
    path and asks; the path joins the credential binding, so a changed path asks again.

Recorded on 2026-11-15, from the owner's answer to the review's open question.

50. **Destination tables:** a console-style per-query destination table setting is not in 0.10.0; it comes in 0.11
    with Save to a BigQuery table, which together lift the 10 GB limit.

Recorded on 2026-11-15, from the owner's answers on job lifecycle.

51. **Re-attach, not cancel:** after a backend restart, a hot exit or a crash, Varia re-attaches to a tab's BigQuery
    jobs (running or finished) through persisted job records and `query.attach`. Quitting Varia leaves jobs running.
    In 0.10.0, as lane BQ-3d.
52. **Close prompt:** closing a tab or Close Results while a job runs asks: Cancel the job, Leave it running, or Don't
    close. Quitting with hot exit off asks the same once. The choice can be remembered in Options.

Recorded on 2026-11-15, at the owner's request.

53. **Job history in 0.10.0:** a live Job History document per connection (my jobs, or all users with permission),
    from free `jobs.list` calls, with Cancel job, Open results, Re-attach, Open SQL and Re-run, as lane BQ-9. It
    replaces the "job history pane" listed for later.
43. **Job records:** a `query.job` event in each query stream tells main the in-flight jobs, which it persists in
    `WorkbenchSession/jobs.json` on every change; `bigquery.cancelJobs` is the fallback when re-attaching is impossible.
46. **Remote queries:** windowed sort, filter, value lists, Load sample, Load into memory and Re-run run through one
    stream method, `results.remoteQuery`, on the query lane; the protocol stays v2.
47. **Key files on the wire:** an opaque reference (pick token or profile id); only main knows the path.
44. **No automatic dry run** after a provider switch or restore until the user edits or executes.
45. **Cache hits** that would be windowed are marked as possibly expiring early.

## Mocks

[docs/mockups/bigquery-ui.html](mockups/bigquery-ui.html) shows each UI change on Varia's own renderer: its captured DOM,
stylesheet and dark theme, edited per scene. Open it in a browser; Annotations marks what is new. Where a mock and this
page differ, this page wins: the review changed the cost prompt's wording (incomplete estimates) and limited Preview
Rows to tables.

The Job history group shows BQ-9 and BQ-3d: opening Job History (Explorer menu and palette), my jobs with a script
expanded, a running job's details, the row menu, All users with details hidden by BigQuery, All users refused, the cancel
prompt, the prompt when closing a tab with a running job, and a tab re-attached after a restart.
