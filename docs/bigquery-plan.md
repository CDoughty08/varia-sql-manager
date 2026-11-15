# BigQuery support plan (0.10.0)

Status: **agreed with the owner on 2026-11-15.** Nothing here is implemented yet. The lanes below become PRs.
[Decisions](#decisions) records the owner's answers.

0.10.0 is meant to deliver two things: BigQuery support and SQL Server Agent support. Agent is planned separately. This
page covers BigQuery and calls out the shared infrastructure both plans touch (marked **Shared**).

## Goals and non-goals

Goals for 0.10.0:

- Connect to BigQuery with Google credentials the user already has, with no secret in clear on disk.
- Browse projects, datasets, tables, views, routines and models in Object Explorer.
- Run GoogleSQL, scripts included, with results that look like one continuous result set. Varia does the BigQuery
  paging itself, inside the existing result budget, with explicit truncation, a working Stop, and cost shown.
- GoogleSQL editing: highlighting, completion from the Search Objects index, and errors from dry runs.
- SQL Server behaviour stays exactly as it is. SQL Server-only features are hidden for BigQuery connections, never
  half-working.

Not in 0.10.0 (candidates for 0.11, listed in [Later](#later)): browser OAuth sign-in with a Varia-owned Google client,
the Storage Read API, a job history pane, a viewer for query plan stages, table edit actions, BigQuery ML, and writing
results back to tables.

## What the code already has

- The language contract already names `bigquery` (`src/shared/language-service.ts`) and has `project`/`dataset` context
  fields. `LanguageServiceBroker` routes by provider id, though it has only the SQL Tools provider.
- `ConnectionInfo.providerId?` exists, but main pins it to `'sqlserver'` and the backend record lacks it. The connection
  principal uses a second spelling, `'sqlServer'` (`connection-targets.ts`, `connections.ts`). This plan uses one id.
- The results pipeline below the reader is engine-neutral: `ResultStore`, `ResultSetBuffer` (`BeginRow`, `TryCommitRow`,
  `Seal`, `Complete`) and `PageBuilder` (text and binary cells). The SQL Server coupling sits in `ColumnPlan`
  (`Results/ColumnReaders.cs`), which reads a `SqlDataReader`. DATA pages, the worker, the grid, sort, filter, pivot,
  diff, Copy and Save need no change for a second engine.
- Everything else is SQL Server-shaped: `ConnectionOptions`, the auth modes, `connectionKey`/`credentialBinding`,
  `SqlService`'s connection dictionaries, the Explorer catalogue's kinds and scope fields, and the context keys (the only
  "engine" keys today are SQL Server editions: `box`/`managedInstance`/`cloud`).
- The Search Objects index is not yet read by completion. The query-editor direction agreed on 2026-11-14 makes it the
  single metadata source, and BigQuery should be its first consumer that does not use SQL Tools.

## 1. Connections

### Provider in the connection model (BQ-0, **Shared**)

- One `ProviderId = 'sqlserver' | 'bigquery'` in `src/shared/`, replacing both spellings. `postgresql` stays reserved in
  the language contract only.
- `ConnectionOptions` becomes a discriminated union on `provider`. A missing `provider` means `sqlserver`, so
  `connections.json`, `session.json` workspaces and saved-password bindings all read unchanged, with no schema-version
  bump. The SQL Server branch keeps today's strict fields. The BigQuery branch is a strict shape of its own:

  | Field | Notes |
  | --- | --- |
  | `provider: 'bigquery'` | |
  | `project` | The billing project that jobs run in. Required. Validated as a project id, domain-scoped ids (`example.com:proj`) included |
  | `location?` | The default job location (`US`, `EU`, `us-east1`, …). Detected from the dataset when omitted |
  | `dataset?` | The default dataset for unqualified names (the "database" dropdown's role) |
  | `extraProjects?` | Read-only projects shown in Explorer (for example `bigquery-public-data`), at most 16 |
  | `authentication` | `gcloud` \| `serviceAccountKey` \| `externalAccount` (see below) |
  | `keyFile?` | A path, for key files and external-account configs (see below) |
  | `maximumBytesBilled?` | A per-connection guard sent with every job |
  | `displayName`, `color`, `environment` | Shared with SQL Server, so the Production tag works |

- `connectionKey` and `credentialBinding` dispatch on the provider. A BigQuery binding hashes the provider, project,
  authentication, key path and resolved principal.
- `ConnectionInfo` gains `providerId` in the backend record. Main's literal widens to the union.
- **Shared with Agent:** context keys `activeDocumentProvider` and `explorerProvider` (`'sqlserver' | 'bigquery' | ''`),
  and a `providers` field on catalogue entries (commands, menus, Explorer kinds and actions) that defaults to
  `['sqlserver']`. A lint fails when an entry's precondition reaches a provider it does not declare. Agent's new
  commands and Explorer kinds then get the right gating without doing anything. Agent should land on top of BQ-0, or
  declare `providers: ['sqlserver']` explicitly if it lands first.

### Authentication

| Mode | How it works | 0.10.0 |
| --- | --- | --- |
| **gcloud credentials (ADC)** | `GoogleCredential.GetApplicationDefaultAsync()`: `GOOGLE_APPLICATION_CREDENTIALS`, then the file `gcloud auth application-default login` wrote, then the metadata server. Varia stores nothing. The dialog says how to sign in with gcloud when no credentials are found | Yes (the default) |
| **Service account key** | The user picks a JSON key in main's open dialog. Main reads the file and sends it to the backend in a sensitive request. The backend loads it only as `CredentialFactory.FromJson<ServiceAccountCredential>`, never the obsolete `GoogleCredential.FromJson`, which would accept any credential type | Yes |
| **Workforce/Workload Identity Federation** | An `external_account` JSON config, typed load. An untrusted config can run executables or fetch URLs, so the backend accepts only `credential_source.file` and `url` sources whose URL is HTTPS on an allowlist (Google's STS and IAM credentials hosts plus the config's own token URL host, shown to the user), and refuses `executable` sources | Yes, file and URL sources |
| **Service account impersonation** | `CreateImpersonated` on top of any of the above, with a target account field | Yes (small) |
| **Browser sign-in (OAuth)** | Loopback redirect plus PKCE, through a Varia-owned Google OAuth client. The BigQuery and cloud-platform scopes need Google's sensitive-scope verification (until then: an "unverified app" screen and a 100-user cap). The device flow cannot be used: Google does not allow BigQuery scopes on it | **Later**, after verification (decided) |

Rules (these follow the existing invariants):

- Tokens and key material live only in backend memory, as Entra tokens do. Neither reaches main's logs, the renderer,
  or a receipt.
- Recommended: **remember the key file's path, not its contents.** The secret stays where the user put it, and Varia
  writes no new copy. A path is not a secret, so it goes in `connections.json`. The alternative is to import the key into
  `saved-passwords.json` as `safeStorage` ciphertext, with the same platform rules as Remember Password. **Decided: remember the path.**
  A browser sign-in's refresh token would go there too, when it comes.
- Identity pinning: the resolved principal is the evidence. For a service account that is `client_email`. For a user or
  ADC credential it is the token's email from Google's tokeninfo endpoint, which ADC's default scopes allow. The pin is
  checked again when credentials refresh, so an ADC file re-pointed at another account fails `AUTH_IDENTITY` instead of
  silently switching accounts.
- The connect probe is a dry run of `SELECT 1` in the billing project. It proves `bigquery.jobs.create` and costs
  nothing. `projects.list` fills the project picker. `datasets.list` fills the dataset picker and detects the location.
- Background reconnect works for ADC, key files and external accounts, which never need interaction. A browser sign-in
  would follow the Entra rule: never escalate to a browser in the background.

### Connect dialog, saved connections, Explorer

- The dialog gets a **Server type** select (SQL Server | BigQuery) at the top. It defaults to the last type used, so
  SQL Server users see no difference. BigQuery swaps the field block: Project (an editable combo listing
  `projects.list`), Authentication, Key file (Browse… through main's dialog), Location, Default dataset, and an Advanced
  section with Maximum bytes billed, Impersonate service account and extra projects. Encrypt, TLS and the SqlClient
  advanced options are not shown.
- Saved connections, favourites, MRU, Production colour and auto-reconnect work unchanged on the union. Registered
  Servers' Browse (local and network instances) stays SQL Server-only.
- In Object Explorer a BigQuery connection is a root of its own (see [Object Explorer](#object-explorer-bq-5)).

## 2. Seamless results

### How paging is hidden

BigQuery pages a query's rows (`getQueryResults`/`tabledata.list`: at most 10 MB or 100,000 rows a response, a page token
to the next). Varia already streams rows into the result store as a reader produces them, so **the backend reads every
BigQuery page into the store itself, ahead of the grid**, just as it reads a `SqlDataReader` to the end. The grid only
ever sees `ResultSetBuffer` pages. It never sees a BigQuery page token or a "load more".

- One fetch loop per result set. While page *n* is decoded into `PageBuilder`, request *n + 1* is in flight: one
  response ahead, never more, with its bytes reserved as working memory from the query's budget before the request goes
  out. That gives a steady stream without loading the whole result into memory twice.
- `maxResults` is chosen so a response stays near 4 MB (from the schema's estimated row width). The first page is
  requested small (500 rows), so the first rows show fast, as the 64-row first page does for SQL Server.
- The descriptor gets an optional `rowsTotal` (BigQuery's `totalRows`, known before the first row). The grid and status
  bar can then say "1,000,000 of 52,341,118 rows" while it streams and after a truncation. The field is optional, so the
  protocol version stays v2 (as `name` did).
- Truncation is the existing set of reasons (`rowLimit`, `queryBudget`, `globalBudget`, `systemMemory`), and fetching
  stops at the truncation. The note adds that BigQuery keeps the full result for about 24 hours in a temporary table,
  and Save Results As can export it from there (below). A stop is never undone, which is the existing rule.
- Room for a query: while the packing policy makes room, the fetch loop waits exactly as `WaitAndCommitAsync` makes the
  SQL Server reader wait. BigQuery holds nothing open, so a pause costs nothing on the server side.
- **Save Results As past the budget** (recommended, small): for a truncated BigQuery result, Save offers "all
  52,341,118 rows from BigQuery". This streams the job's destination table page by page straight to the file through
  `ResultTextWriter`, never into the store, so results still never touch disk except in the file the user chose. It
  can wait for 0.11 if the release is tight.

### Jobs, scripts, Stop, cost

- **Execution:** `jobs.query` with the default dataset, location, `maximumBytesBilled`, labels (`varia_client`), and
  optional job creation (BigQuery returns small results inline with no job, which is quicker). Long queries come back
  as a job, polled until done. The job id and location go in Messages, so the user can find the job in the console.
- **Scripts:** a script runs as one parent job, and BigQuery returns only the last statement's rows. Varia lists the
  child jobs (`jobs.list?parentJobId=`) and reads each `SELECT` child's results in order, as result sets 1…n. DML and DDL
  children become Messages lines ("(1,204 rows affected)", "Table created."). The existing `maxResultSets` limit
  applies. There is no `GO`: the editor text goes up as one script, and the selection when there is one.
- **Stop:** `query.cancel` stops the fetch loop at once (the rows read so far stay, marked `incomplete`) and calls
  `jobs.cancel` on the parent job. Cancel is best-effort, so the message says BigQuery may still bill work done before
  it stopped. An inline (no-job) query has nothing to cancel: Stop stops waiting. Such queries are short by BigQuery's
  own choice, and `maximumBytesBilled` bounds them.
- **Cost:** every summary reports bytes processed, bytes billed, cache hit, slot time and the job id, in Messages, and
  the bytes processed in the status bar beside the row count.
  - **Before execute** (setting, on by default): a dry run (free). When its estimate passes a threshold (setting,
    default 10 GB), a prompt shows "This query will process 1.4 TB (about $8.75 on demand). Run it?", with Run,
    Cancel, "Don't ask again for this connection" and a **Cost settings…** link. The link opens Tools › Options at the
    BigQuery cost section, the same way other pages link to their settings. The price is labelled an on-demand
    estimate, because projects with capacity (reservations) do not pay per byte.
  - **Caps are configurable** and are the hard guard. A global default in Tools › Options (BigQuery › Cost: maximum
    bytes billed per query, empty by default) applies to every connection, and each connection can override it in the
    dialog's Advanced section. The effective cap goes out as `maximumBytesBilled` with every job, so BigQuery fails
    the job, at no charge, past it. The prompt threshold, the prompt on/off switch and the dry-run diagnostics switch
    live in the same Options section.
- **Sessions:** each query tab gets a BigQuery session, created on its first execution (no extra charge). Temp tables,
  variables and `BEGIN TRANSACTION … COMMIT` then carry across executions, like a SQL Server tab's session. Closing the
  tab ends it (`CALL BQ.ABORT_SESSION()`). A session runs one query at a time, which a tab already does. Prompting on
  close for an open transaction is SQL Server-only in 0.10.0: BigQuery rolls back an abandoned session's transaction
  (decided: a session per tab, on by default).

### Types and display

Rows are decoded from the REST `TableRow` JSON by Varia's own converter, not `BigQueryRow`. The client throws on `RANGE`
and `INTERVAL`, and its own converter would format values and use memory outside the budget's accounting.

| GoogleSQL | Cell | Display |
| --- | --- | --- |
| INT64, FLOAT64, NUMERIC, BIGNUMERIC, BOOL | text | Invariant culture, full precision (BIGNUMERIC to 38 scale digits), `true`/`false` |
| STRING | text | As is, with existing cell-length truncation |
| BYTES | binary | `0x…` as today |
| DATE, TIME, DATETIME, TIMESTAMP | text | ISO 8601. TIMESTAMP in UTC with `UTC`, microseconds kept |
| INTERVAL, RANGE | text | BigQuery's canonical text (`1-2 3 4:5:6`, `[2024-01-01, 2024-02-01)`) |
| GEOGRAPHY | text | WKT |
| JSON | text, role `json` | Open Value opens the JSON viewer |
| STRUCT, ARRAY | text, role `json` | Compact JSON text, so a cell stays one cell. Open Value shows it formatted |

`ResultColumn.dataType` carries the GoogleSQL type (`ARRAY<STRUCT<a INT64, b STRING>>`). Sort, filter, profile and pivot
work on the text and number cells as today. Flattening nested columns into grid columns is not planned (BigQuery's
console does not do it either).

### Storage Read API: not in 0.10.0

The Storage Read API (gRPC, Arrow) is faster for very large results, but in-memory results are bounded by the budget
(at most 16 GiB, usually a few GiB), and REST paging allows 7.5 GB a minute in US/EU. It adds gRPC, Apache.Arrow, another
permission (`readsessions.create`) and a price whose rules for temporary result tables are unconfirmed. Recommendation:
measure REST throughput in BQ-3's benchmark first, and add Storage Read in 0.11 only if filling a typical budget takes
too long.

## 3. Query support

### GoogleSQL in Monaco (BQ-4)

- A new Monaco language, `googlesql`, with its own Monarch tokenizer. It covers backtick identifiers with dots and
  dashes (`` `my-proj.ds.table` ``), `r`/`b`/`rb` prefixes, triple-quoted strings, `#` and `--` and `/* */` comments,
  `@param` and `@@system_variable`, `STRUCT<…>`/`ARRAY<…>`, and GoogleSQL's keywords and reserved words. Brackets and
  auto-closing pairs come from a language configuration.
- A document kind `bigquery` ("GoogleSQL") beside `sql` ("Transact-SQL"). A query tab's language follows its
  connection's provider. Changing a tab's connection to another provider switches the model's language and clears its
  markers, and the editor says so, since the SQL is unlikely to run as is.
- Keyword and function lists are a generated catalogue (`src/shared/googlesql/catalog.ts`: functions with signatures
  and one-line descriptions) with a regenerate test, following the other catalogues.

### Search Objects for BigQuery (BQ-6a)

The index is the single metadata source, so one BigQuery index serves Search Objects, the header's Search (Ctrl+Q) and
IntelliSense. As for SQL Server, it is one index per connection, in backend memory only, under the shared 512 MiB
`IndexBudget`, and dropped on disconnect.

**Free REST calls are enough. The indexer does not need `INFORMATION_SCHEMA`.** It builds in two passes, so names are
searchable within seconds and details fill in behind them:

1. **Names:** `datasets.list` for each project (the billing project plus extra projects), then `tables.list`,
   `routines.list` and `models.list` for each dataset. That is one paged call per dataset per kind, giving every object's
   name, kind (table, view, materialized view, external, snapshot, clone), creation and modified times, and labels.
2. **Details:** `tables.get` for each table: columns with types, descriptions and nested STRUCT fields, partitioning,
   clustering, row count and size. For views and materialized views it also returns the view text. For routines,
   `routines.get` returns arguments, return type and body.

What REST costs is time, not money: one `tables.get` per table, within BigQuery's 100 requests a second per user and
method. Varia caps itself below that (16 in flight), so 10,000 tables take about two minutes for pass 2 while pass 1's
names are already searchable. The `lastModifiedTime` from pass 1 lets a refresh re-read only the objects that changed.
The optional bulk path (setting, off by default) replaces pass 2 with one region-scoped
`INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` (plus `ROUTINES`, `VIEWS`) query per region. That is much faster on very large
projects, but each query bills at least 10 MB and is never cached, so it is the user's choice.

Search Objects enhancements this needs (in BQ-6a, with the index's limits mirrored in C# as today):

- Index entries carry the scope `project` › `dataset` › `name` in place of `database` › `schema` › `name`. Kind filters
  list the BigQuery kinds (table, view, materialized view, external table, snapshot, routine, procedure, table function,
  model), shown only for BigQuery connections.
- Name search covers project, dataset and object names. Definition search covers view and materialized view text and
  routine bodies. Column search covers column names and nested field paths (`address.city`), with the column's type in
  the result row.
- The details pane shows the schema (columns, types, descriptions, nested fields), partitioning and clustering, rows,
  size, labels and the view or routine text. Long text is paged by the existing `shownChars` rule.
- Result actions: Locate in Object Explorer, Preview Rows, Script As, copy the backtick-quoted full name, and open a new
  query on the object's connection.
- "All servers" search spans SQL Server and BigQuery connections together. Each result row shows its provider and
  connection.
- Progress, partial results and per-dataset failures (a dataset the principal cannot list) use the existing build
  status and skipped-database values, worded for datasets.
- `explorer.index` builds the BigQuery index through the same method (routed by provider). No new method is needed
  beyond the index DTO's scope fields.
- Never log names, definitions or search text (the existing rule).

### IntelliSense from the index (BQ-6b)

- Completion is Varia's own, from the index, with no language server: keywords, functions with signature help, then
  projects, datasets, tables and columns. A light GoogleSQL scope reader resolves `FROM`/`JOIN` aliases and `WITH` names
  to columns. This is the "own completion from the index" stage of the query-editor direction, built for BigQuery first,
  and it needs the index's planned column-type metadata (stage 1 of that direction: **Shared** with the editor work).
- Hover: a table's schema summary (columns, types, partitioning, row count, size) and a column's type and description.
- Diagnostics (BQ-7): a dry run after an editing pause (1 s, one in flight per document, latest wins) gives the
  syntax and binding error with its `[line:column]`, mapped to a marker. It also gives the estimate, shown in the status
  bar as "This query will process 1.2 GB", as BigQuery Studio does. Dry runs are free but count against API quota, so a
  setting turns them off.

### Script As and actions (BQ-5)

| Action | BigQuery equivalent |
| --- | --- |
| Select Top 1000 Rows | **Preview Rows**, through `tabledata.list` (free; `LIMIT` would still scan and bill the whole table). It opens a read-only result, not a query |
| Script As SELECT | `SELECT col, … FROM \`p.d.t\` LIMIT 1000;` in a new tab, with a comment that LIMIT does not reduce bytes scanned |
| Script As CREATE | The `ddl` column of `INFORMATION_SCHEMA.TABLES`/`ROUTINES` (one query, about 10 MB billed, the user's action) |
| Script As INSERT, UPDATE, DELETE, DROP | Templates built locally from the schema; nothing runs |
| Go To Definition / Peek | Views' and routines' text from `tables.get`/`routines.get` into Peek (0.10.0 if time allows; otherwise Later) |
| Properties | A read-only facts page (`tables.get`: type, partitioning, clustering, expiration, labels, size, rows) |
| Rename, Delete, Table Designer, object actions | Not in 0.10.0 |

## 4. Architecture fit

### Backend

- New folder `backend/Varia.Backend/BigQuery/` with `BigQueryService`, which owns BigQuery connections (credential,
  `BigQueryClient`, pinned principal, tab sessions) in a registry keyed by the same handle ids as SQL Server connections.
  `SqlService` keeps its SQL Server dictionaries. `connections.connect` and the provider-neutral methods route by the
  handle's provider at the top of the method.
- **Methods:** reuse the existing method where the meaning is the same, so results and ownership plumbing stays single:
  `connections.connect` (the union), `connections.disconnect`, `query.execute`, `query.cancel`,
  `query.session.close`, `explorer.children`, `explorer.index`/`explorer.search`, `language.*` and every `results.*`.
  New methods, each added in all five places with bounded strings: `bigquery.projects` (the dialog's picker),
  `bigquery.dryRun` (estimate and diagnostics) and `bigquery.preview` (Preview Rows). A SQL Server-only method called
  with a BigQuery handle answers a new `UNSUPPORTED_PROVIDER` error value. It never throws.
- `query.execute` keeps its args. The SQL Server-only fields (`includeActualPlan`, `includeLivePlan`,
  `includeClientStatistics`, `stopOnError`) are refused for BigQuery by validation in main and again in C#.
- **Rows:** `ColumnPlan` becomes an interface over a reader. `SqlColumnPlan` is today's code. `BigQueryColumnPlan`
  writes converter output into `PageBuilder`. `ResultSetBuffer`, budgets, packing and every reader after the store are
  unchanged.
- **SQL the backend runs:** BigQuery runs SQL only for Script As CREATE, the optional bulk index and the connect probe.
  The same rule applies: constant text in `BigQuery/BigQuerySql.cs`, values as query parameters. Identifiers cannot be
  parameters in BigQuery and there is no `QUOTENAME`, so project, region and dataset names go in only through
  `BqNames.Quote`, which validates against BigQuery's identifier grammar and backtick-quotes. An offline lint renders
  every template with hostile names. Metadata uses REST wherever it can, so most paths have no SQL at all.
- **Bounds:** HTTP requests have deadlines inside each method's deadline. Response bodies are read into the budget
  (one page ahead at most). Dry-run and metadata calls have per-connection concurrency caps. A 429 or 5xx gets one
  bounded retry for idempotent reads only, never `jobs.query` (a request is never re-sent). Never log SQL, names,
  values, tokens or keys. The Google libraries' own logging stays off.
- **Packages:** `Google.Cloud.BigQuery.V2` 3.12 (REST, Newtonsoft.Json) and `Google.Apis.Auth`. The backend is
  ReadyToRun, not trimmed or AOT, so they fit. BQ-1 records the installer size growth. A license and notice review goes
  in that PR.

### Renderer and main

- `ConnectionService` and the target registry carry the provider. `connection-open.ts` resolves credentials per
  provider (it reads key files for BigQuery).
- Query tabs: the database dropdown becomes a dataset dropdown for BigQuery. The status bar shows the principal and
  project instead of `login (spid)`, plus bytes processed.
- **Hidden or disabled for BigQuery** (through `providers` in the catalogues, not ad hoc checks): Activity Monitor;
  SSIS; SQL Server Agent (**Shared**); Table Designer; object actions (Rename, Delete, Properties pages, Restore,
  Attach, logins); actual, estimated and live plans; client statistics; `sp_help`/`sp_who`/`sp_lock` templates; Go To
  Definition through ScriptDom (BigQuery's comes from REST); named result set markers (`#Name=`); Registered Servers'
  instance browse; Explorer status chips; transaction prompts on close; Encrypt and TLS options; SQLCMD settings.
- Results, grid, pivot, compare, transpose, search, highlights, Copy and Save, popouts, hot exit and AutoRecover work
  as they are.

## 5. Testing

| Layer | What | Runs |
| --- | --- | --- |
| Offline .NET | A fake BigQuery HTTP handler injected through `BigQueryClientBuilder`, replaying recorded REST JSON: paging and page tokens, the prefetch bound, truncation at each reason, child-job scripts, inline results, cancel, errors with `[l:c]`, every type (RANGE and INTERVAL included), identity pin changes, rejected external-account configs, `BqNames` and the SQL lint | `npm run check`, every PR |
| vitest | Tokenizer golden files, completion and alias scope, catalogue `providers` lint and gating, the connection union's back-compatibility on old `connections.json`/`session.json` files, dialog form logic, the cost-prompt logic | `npm run check` |
| Smoke | The connect dialog's BigQuery path, Explorer browse, execute and stream, Stop, the cost prompt, hidden SQL Server commands. It runs against the emulator, pointed at by `VARIA_TEST_BIGQUERY_ENDPOINT`, and skips when that is unset | A smoke shard on Linux |
| Emulator live | `ghcr.io/goccy/bigquery-emulator` 0.8.x as a CI service container: queries, paging, scripts, parameters, cancel, types and REST metadata. It does not cover sessions, dry run, bytes statistics, routines or full INFORMATION_SCHEMA, so those stay on the offline fakes and the real-project checks. Whether the .NET client works against it (`BaseUri`) is unconfirmed: BQ-1 checks that first | A new live group on Linux only (estimate: under 2 min including the image pull; recorded in docs/ci.md) |
| Real project (opt-in) | `VARIA_TEST_BIGQUERY_PROJECT` plus ADC or `VARIA_TEST_BIGQUERY_KEY_FILE`. It uses public datasets and one scratch dataset with a 1-day expiration, with `maximumBytesBilled` 100 MB per job. It proves sessions, dry run, cost figures, child jobs and identity pinning | Local only, no repository secret (decided) |

The free tier (1 TiB of queries a month) covers the real-project checks many times over. A sandbox project cannot run
DML, so the scratch checks need billing enabled.

## 6. PR lanes

Sizes: S under a day, M a few days, L about a week. Lanes on the same row of the order can run in parallel.

| Lane | Contents | Size | After |
| --- | --- | --- | --- |
| **BQ-0** Provider foundation (**Shared**) | One `ProviderId`; the connection-options union, with old files reading as SQL Server; per-provider keys and bindings; `activeDocumentProvider`/`explorerProvider`; catalogue `providers` and its lint; `UNSUPPORTED_PROVIDER`. No BigQuery behaviour | M | — |
| **BQ-1** Backend engine and connect | Packages and size check; `BigQueryService` and its registry; ADC, key file, external account and impersonation; identity pin; connect probe and disconnect; fake HTTP handler; emulator `BaseUri` check | M | BQ-0 |
| **BQ-4** GoogleSQL editor | `googlesql` language and tokenizer; document kind; switching language on connection change; keyword and function catalogue with signature help | M | BQ-0 |
| **BQ-2** Connect dialog and saved connections | Server type; BigQuery fields; key file picker through main; projects and datasets pickers; saved connections and MRU; query tab dataset dropdown and status bar | M | BQ-1 |
| **BQ-3** Execution and seamless results | Fetch loop with one-ahead prefetch; `BigQueryColumnPlan` and converter; `rowsTotal`; truncation notes; scripts' child jobs; Stop and `jobs.cancel`; cost figures; tab sessions; `maximumBytesBilled`; REST throughput benchmark | L | BQ-1 |
| **BQ-5** Object Explorer | Catalogue kinds (project, dataset, tables, views, materialized views, external tables, routines, models; nested columns) and the `project`/`dataset` scope fields; REST listers; Preview Rows; Script As; Properties facts | M | BQ-1 (BQ-2 to try it in the app) |
| **BQ-7** Dry run | `bigquery.dryRun`; the estimate before execute and the threshold prompt; status bar estimate; diagnostics markers | S–M | BQ-3, BQ-4 |
| **BQ-6a** Search Objects index | Two-pass REST index builder (names, then details; refresh by `lastModifiedTime`); optional billed bulk path; Search Objects scope, kinds, column and definition search, details pane, result actions, All servers across providers | M–L | BQ-1, BQ-5 |
| **BQ-6b** IntelliSense | Own completion from the index with alias scope; signature help from the function catalogue; hover | L | BQ-4, BQ-6a, and the index's column metadata from the editor plan |
| **BQ-8** Live checks and docs | Emulator CI group and smoke shard; real-project opt-in suite; README, a Getting Started guide and sample (`src/shared/help/catalog.ts`), CHANGELOG Unreleased | M | lands alongside each lane; final pass last |

Critical path: BQ-0 → BQ-1 → BQ-3 → BQ-7, with BQ-5 → BQ-6a → BQ-6b beside it. BQ-0 first also gives Agent its gating. If the
release is tight, BQ-6b's completion can ship with objects and keywords only (no alias scope), and Save past the budget,
Peek and Properties can move to 0.11 without hurting the core experience.

## Later

- Browser OAuth sign-in with a Varia-owned Google client (needs Google's verification) and refresh tokens in
  `safeStorage`.
- Storage Read API for large results and fast Save, if BQ-3's benchmark calls for it.
- Execution details: BigQuery's query plan stages and timeline in the plan canvas.
- Job history pane (`jobs.list`), reopening a past job's results.
- Table actions (delete, copy, expiration, labels), dataset creation, the external-account `executable` source behind
  an explicit opt-in.

## Decisions

Recorded on 2026-11-15, from the owner's answers to the draft's open questions.

1. **Auth in 0.10.0:** gcloud credentials (ADC), service account key, Workforce/Workload Identity Federation and
   impersonation. Browser sign-in waits until a Varia Google OAuth client is verified (0.11 or later).
2. **Key files:** a saved connection remembers the key file's path, not its contents.
3. **Cost guard:** the estimate prompt is on by default above 10 GB, with no hard cap by default. **Caps must be
   configurable:** a global default in Tools › Options plus a per-connection override, and the threshold and switches
   in the same Options section. The prompt links to that Options section.
4. **Sessions:** a BigQuery session per query tab, on by default.
5. **Metadata:** the Search Objects index and IntelliSense use free REST calls. The billed `INFORMATION_SCHEMA` bulk path
   is opt-in. Search Objects gets the BigQuery enhancements in [Search Objects for BigQuery](#search-objects-for-bigquery-bq-6a).
6. **Live tests:** the emulator runs in CI. Real-project checks stay local and opt-in, with no repository secret.
7. **Plan location:** this page, landed as a docs-only PR.
