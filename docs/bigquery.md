# BigQuery

Varia connects to Google BigQuery beside SQL Server. This page describes the engine as it works now: sign-in, identity
pins, connect and disconnect, the pre-connect methods, errors, emulator mode and testing. The Connect dialog's BigQuery
fields, query execution and Object Explorer come in later lanes (docs/bigquery-plan.md); until the dialog lands, nothing
in the app opens a BigQuery connection.

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
  windowed results) adds 5.4 MB more (2.2 MB compressed).

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
  names a key or configuration file only by an opaque reference (`BigQueryKeyFiles`: a pick token or a saved profile's
  id), never a path. A picked file must be a regular `.json` file on a local disk (never a UNC share or device path);
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

Main passes a BigQuery connect straight to the backend with the credential added, and registers the handle's provider
so methods for the other engine are refused before they reach it. Saved profiles, the reuse coordinator, principal
pins in main and connect receipts come with the connect dialog (docs/bigquery-plan.md, BQ-2).

`connections.disconnect` releases the handle and its client. A SQL Server method for a BigQuery handle answers
`UNSUPPORTED_PROVIDER` (docs/ipc.md#providers).

## Pre-connect methods

The dialog's account line and project picker run before a connection exists. Both are sensitive, on the control lane,
with 30 s; the renderer sends the mode, key file reference and impersonation target, and main adds `credential`.

- `bigquery.account` signs in and answers `{ kind, account, impersonated? }`, creating no job.
- `bigquery.projects` answers one page of BigQuery's `projects.list` (up to 1,000, with `nextPageToken`), dropping ids
  that are not valid project ids and control characters in friendly names.

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
| `TIMEOUT` | Connect's or a pre-connect method's budget passed | Try again |

## Emulator mode

`VARIA_TEST_BIGQUERY_ENDPOINT` points the backend at a BigQuery emulator. Main passes it only to unpackaged backends
and only as a loopback http address with no path (`bigQueryEmulatorEndpoint`); the backend checks it again. In emulator
mode main sends only anonymous material, the backend signs nothing, skips the connect probe, and fakes estimates.

The emulator (`ghcr.io/goccy/bigquery-emulator` 0.8.1) differs from BigQuery in ways the checks rely on: it answers dry
runs with HTTP 500, names projects in `projects.list` only by `id`, gives datasets no location, answers `tabledata.list`
in one page whatever `maxResults` asks, finishes jobs synchronously, and reports `INT64` where BigQuery says `INTEGER`.

## Testing

- **Offline.** `BigQueryChecks` and `BigQueryCredentialChecks` (in the offline .NET run; alone with
  `-- --bigquery-checks`) drive connect, disconnect and the pre-connect methods through `SqlService.DispatchAsync`
  against `BigQueryFake`, an HTTP handler injected through `BigQueryEnvironment.Http` that answers Google's endpoints
  from `backend/Varia.Backend.Tests/Fixtures/BigQuery` (hand-written from Google's documented shapes) and fails any
  request no route answers. They cover every mode's sign-in and pin, every error row, the accepted and refused
  credential shapes, and emulator mode. `tests/bigquery-credentials.test.ts` covers main's side.
- **Emulator.** `-- --bigquery-emulator-live` with `VARIA_TEST_BIGQUERY_ENDPOINT` runs emulator mode end to end and the
  REST calls later lanes build on (client job ids, result and table paging, scripts, parameters, cancel, metadata). CI
  runs it in live group 1 (docs/ci.md). Locally, start the emulator with Docker or Podman:

  ```bash
  docker run -d --name varia-bigquery -p 9050:9050 ghcr.io/goccy/bigquery-emulator@sha256:f4e428d265a93dc5ce36c294e1c584c7c9b384117d47ab8ddbb63d8d50b7f393 --project=varia-emulator --dataset=varia_fixture
  ```

  On Windows use `http://127.0.0.1:9050` (`localhost` may resolve to IPv6 first).
- **Never a real project.** No check contacts Google Cloud. What only a real project can prove (tokeninfo and STS
  answers, Google's exact error bodies) stays on the hand-written fixtures until the owner runs a check against one.
