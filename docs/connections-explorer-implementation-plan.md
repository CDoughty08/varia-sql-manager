# Connections and Object Explorer implementation plan

Connections become durable targets that query tabs and Object Explorer can remember while their live backend
connections are replaced. An equivalent connection reuses one Explorer entry. Different credentials or connection
settings remain separate. This plan records the decisions agreed on 2026-11-12 and defines the foundation and the
three implementation tracks that build on it.

## Agreed behavior

### Connection matching and details

Match the submitted destination, initial database, authentication mechanism, resolved account, credentials,
encryption and certificate settings, advanced options, and execution policy. Preserve database and account case and
routing choices; do not merge DNS aliases, availability-group listeners, ports or instances based on an observed
server name. Inherited command timeout differs from an explicit timeout, including zero. Query tabs sharing an
Explorer target still own separate SQL sessions.

Display name, color, environment, favorites and reconnect preference do not create another target. An exact match
selects the existing tree. Opening an equivalent disconnected target reconnects that target. Explicit New Query
still opens a query; ordinary reuse and startup reconnect never manufacture or retarget an unrelated query tab.

When the selected connection would change the current name, color, environment or reconnect preference, show the
**confirmation dialog** chosen by the user. Its title is **Use selected connection details?** Show only the changed
fields in Current and Selected columns, the common destination/database/account, and effects on attached query badges
or future automatic reconnect. Actions are **Use Selected Details**, **Keep Current Details**, and **Cancel**.
Both reuse choices retain the existing target and SQL sessions. Cancel returns to the picker. Exact matches do not
prompt. Favorites remain a saved-profile preference and never trigger this dialog. Startup uses the workspace's
remembered details and never opens the details dialog.

The target owns the details shown in Explorer and on its associated queries. Saved profiles keep their own details;
choosing one does not overwrite another profile. The selected confirmation is illustrated by
[the details review mock](mockups/connection-details-conflict.html); its inline-review alternative is retained as a
design reference only. [The workbench mock](mockups/connections-explorer.html) illustrates the lifecycle flows.

### Disconnect and removal

Disconnect collapses the server, clears its children, cancels outstanding loads, and retains its position, label,
environment, account information and disconnected state. Reconnect is available from its context menu, toolbar,
query target and connection picker. Metadata is loaded afresh after reconnect.

Connected roots offer Disconnect and Disconnect and Remove from Explorer. Offline roots offer Reconnect and Remove
from Explorer. Commands, toolbar labels, context menus and the command palette use the shared command catalog.
Removing Explorer membership leaves saved profiles, passwords and remaining query text alone. Query tabs can keep a
hidden target, and explicitly reconnecting one reveals its root again. Forget a hidden target only when no document
references it and no live handle or attempt remains.

When query tabs use a server being disconnected, ask which outcome the user wants:

- Disconnect and Keep Tabs retains text, dirty state, each tab's database, target association and available results.
- Disconnect and Close Query Tabs first resolves all affected saves, running-query and transaction choices.
- Cancel and Escape retain the connection and every tab. Explicit saves made during preflight may remain saved.

Run the entire preflight before closing the first tab or disconnecting. Revalidate document versions, target state
and backend generation before mutation. Never silently commit a transaction. Running-query cancellation must be
explicit in the wording, and its possible unknown outcome must remain visible. Long-running restore, catalog creation
and document Apply operations keep their existing blockers. Failed saves, transaction completion or disconnect keep
the relevant tabs open and report the actual outcome. Only query tabs close under Close Query Tabs; custom-document
drafts remain open.

Completed results remain available to read, copy and save after disconnect. Reconnecting does not make retained
results belong to the new session. Closing tabs releases results through the existing close path.

### Hot exit and reconnect

Remember target order, sanitized settings snapshots, chosen details, Explorer membership and connection intent, plus
each query's exact target and selected database. Runtime handles, SPIDs, transactions, results, access tokens and
unremembered passwords are never persisted. Restore targets and query labels immediately as disconnected, then
attempt eligible reconnects in the background.

Automatic reconnect defaults **On**, configurable globally in Tools > Options and per connection as **Use global
default**, **On** or **Off**. A separate `resumeWanted` flag records whether the user intended a target to remain
connected. Explicit Disconnect, removal or cancellation clears it; unexpected backend/network loss preserves it.
An On override does not revive an intentionally disconnected server.

Implementation defaults for the background pass are two concurrent target attempts, one pass per restore generation,
and a 15-second provider-aware attempt cap even when the stored connect timeout is unlimited. Manual connects take
priority. Cancel/removal invalidates queued and active attempts; a late successful handle is disposed and cannot
resurrect a removed target. Do not add periodic retries.

Use existing matching remembered credentials, current integrated identity or a silent identity-provider flow.
Missing credentials, an unavailable keyring, interaction-required authentication, account mismatch, network/TLS
failure and an unavailable database are ordinary per-target failures. Keep the root with a concise reason and an
explicit retry or sign-in action. No automatic browser sign-in or application credential dialogs. OS keychain access
can still request unlock; serialize secret-store initialization and keep the application responsive.

Background success preserves the user's Remember Password choice. It never implicitly remembers or forgets a secret.
After an actual saved-secret rejection, stop queued attempts sharing that credential binding to avoid repeated bad
logins. Network, certificate and database failures do not erase credentials. Never execute a query buffer or write
action automatically; connection validation and metadata reads remain part of ordinary connection establishment.

Use the same eligible-query checkpoint policy for Reload Window and hot exit, preserving the existing rules for
pinned tabs and disabled query restoration. Restored monitors do not automatically resume subscriptions.

### Query associations and dependent documents

Show the remembered server followed by Disconnected in tabs, query pickers, status bars, tooltips and query switching.
Keep the environment visible without implying that the connection is live. Successful reconnect attaches only the
queries that wanted attachment to that exact target. Query-only Disconnect retains remembered context but clears
`attachWanted`, so reconnecting the server does not unexpectedly attach that query. Explicit query reconnect restores
the intent. Change Connection remains the deliberate way to choose another target or clear it.

Preserve each query's database independently; an unavailable database is an error requiring a choice, never a silent
fallback before execution. Reconnect creates fresh SQL sessions. Existing session-restarted notices remain necessary
because temporary tables, SET state and transactions do not survive.

Replace server-name-only reassociation in Database Properties, Table Designer, SSIS, Activity Monitor and other
dependent documents with exact target identity. Retain drafts while disabling refresh/apply operations that need a
connection. Stop live/search/peek work and reject stale replies on disconnect. Popouts share the same target service
and one disconnect operation; preserve appropriate focus around prompts.

## Security and identity boundaries

The saved-profile key and credential binding are not live equivalence keys: both intentionally omit some settings
or passwords. A main-owned, process-local keyed comparison value may compare candidates with successfully
authenticated live handles. It must never enter IPC, renderer snapshots, persisted data, logs or errors. Dynamic
authentication requires trusted resolved-account evidence; a requested username, an empty MFA username or a rotating
access token cannot establish account equality.

Keep the existing OS-encrypted vault for explicitly remembered passwords/client secrets. Entra tokens remain in
backend memory. Persist only allowlisted nonsecret target settings and opaque credential references. The reference
includes a revision so a profile edit, credential replacement or history pruning cannot silently substitute a new
identity for an older target. A missing revision requires credentials. Preserve ciphertext on temporary storage
failure. Never persist an unprotected password hash to deduplicate restored targets.

Connect with different credentials creates/selects a different target. An explicit Update Credentials operation may
preserve a target after successful authentication as the same expected account. Changing the account or destination
requires explicit target-change intent. Editing/deleting a saved profile never redirects existing targets or tabs.
Two unresolved restored targets with the same nonsecret settings remain distinct until trusted authentication can
establish equivalence. Older sessions containing only a server name keep that hint; ambiguous accounts/settings need
an explicit selection.

Whole-workspace encryption is outside this change. Connection inventory, SQL buffers and AutoRecover can contain
sensitive information in several existing private files; encrypting only the new target list would not protect the
whole workspace. This feature retains the existing private-file permissions, atomic writes, strict schemas and
quarantine/recovery behavior. It does not weaken Linux secret-storage fallback rejection.

## Shared foundation

The foundation is additive and does not change the running workbench until the implementation tracks integrate it.
No new backend RPC or persistence endpoint is exposed by the foundation alone.

| Surface | Contract and responsibility |
| --- | --- |
| `src/shared/connection-targets.ts` | Strict nonsecret target/workspace/query-association schemas; presentation details; lifecycle and handle types; reconnect policy; details-difference and confirmation copy helpers. |
| `src/main/connection-identity.ts` | Main-only process-local credential-sensitive comparison keys, including explicit versus inherited execution policy and resolved account evidence. No authentication or automatic reuse. |
| `src/renderer/src/services/connection-targets.ts` | Immutable target snapshots, runtime lifecycle mapping, operation epochs, stale completion rejection, intent and membership, and nonsecret workspace export. No IPC or credential comparison. |

The stable target UUID, optional saved-profile UUID and transient backend handle are different values. A backend
handle is meaningful only in its generation. Connection-attempt tokens contain target ID, attempt ID, generation and
an operation revision. Cancel, loss, removal and a replacement operation invalidate the token; label changes do not.
Completion returns an explicit rejected-handle result for cleanup rather than leaking a late connection.

The registry's integration API is:

| Operation | Required behavior |
| --- | --- |
| `restore(workspace)`, `add(target)`, `exportWorkspace()` | Strictly parse/freeze nonsecret records, retain distinct unresolved targets, and export no runtime state. Restore refuses to discard live/pending transports. |
| `markLostBefore(generation)` | Advance the backend generation and invalidate older handles/operations while preserving connection intent. |
| `beginConnect(id, generation, attemptId, credentialIntent)` | Default credential intent is `preserve`; `update-credentials` must be explicit before the operation starts. Matching callers can join its token. Different intent cannot silently join. |
| `completeConnect(token, handle, authentication)` | Require main-verified principal/credential-reference evidence; bind the first account, preserve an established account, and gate credential revision replacement by operation intent. Omitted credential preserves; explicit null clears only under update intent. |
| Completion result | `accepted` is a new binding; `already-current` is a nonmutating duplicate; `in-use` identifies another owner and must not dispose its handle; `stale` or `rejected` returns an unbound handle to dispose. Rejections preserve the prior identity/credential reference. |
| `failConnect`, `cancelConnect` | Token-matched failure retains resume intent. Explicit `cancelConnect(id)` cancels that target's current attempt and clears resume intent; an asynchronous caller must guard an older token before cancelling. |
| `beginDisconnect`, `completeDisconnect`, `failDisconnect` | Begin only after the full coordinator preflight. Keep the root, preserve a live handle on failed disconnect, and never accept an older operation. |
| `setDetails`, `removeFromExplorer`, `reveal`, `pruneUnreferenced` | Details do not invalidate a pending connect. Disconnect a live target before removing it. Remaining document references retain a hidden target. |

Parsing authentication evidence in the renderer does not establish its authenticity. Main must prove the account,
validate explicit credential-update intent and match the expected identity before returning that evidence. The
renderer registry is a consistency guard, not a substitute for that security boundary. Only one orchestrator owns the
backend request and completion side effects even when several callers join it.

The existing `ConnectionService` remains the compatibility surface until Explorer migrates it. Keep the new target
registry as the eventual source of target identity/lifecycle rather than maintaining two independently mutable
sources. Persistence adds its file/wire integration and version migration against these schemas. New backend or IPC
fields still require all validation and protocol registration points in CLAUDE.md.

## Parallel ownership and integration

Commit and validate the shared foundation before launching the following implementation chats. Each chat uses its
own dedicated worktree and `codex/` branch stacked on the foundation commit. Do not reset or stash the primary
checkout or another chat's work. Each track owns its checks and documentation, and stops at a reviewable committed
change without merging or publishing.

| Track | Owned work and shared seams |
| --- | --- |
| Explorer | ConnectionService adapter, successful connect/reuse/reconnect orchestration in App, workbench and fixture registration, context keys, Explorer tree/model/UI, connection command catalog/shell wiring, confirmation dialog. Integrate authoritative live dedup and pending-attempt coalescing with main/backend. |
| Persistence and query tabs | Session schemas/store/migration, document target fields, `services/targets.ts`, session service, tab/query picker/status presentation, reconnect settings and scheduler, main noninteractive authentication path and credential revisions/preservation. |
| Disconnect handling | New disconnect coordinator, all-or-nothing close preflight, transaction/running-query handling, files/query session helpers, custom-document exact-target reassociation. Expose an orchestration API Explorer calls; do not independently rewrite App or the command catalog. |

Explorer owns initial service wiring in `core/workbench.ts` and the shared workbench fixture. Persistence owns
`services/targets.ts`; Disconnect requests or supplies a focused integration patch for that owner. Add track modules
and tests independently, and coordinate shared-file edits before making them. The parent chat reviews contracts and
integration. Changes to a frozen shared API require an explicit coordination note and compatibility plan.

Persistence also owns the existing connect IPC/preload/validation and backend-authentication files, including
`shared/contracts.ts`, `shared/connections.ts`, `main/connection-requests.ts`, backend contracts and `SqlService`.
Explorer implements authoritative live/pending reuse in a separate main module and supplies its integration seam to
that owner. Disconnect supplies its App/workbench/target-service hook changes for the respective owners to apply.
This keeps the parallel tracks from independently rewriting the same central connection flow. Shared-file integration
patches must identify their required API rather than introducing a second connection owner.

## Verification and documentation

Foundation checks cover secret/unknown-field rejection, bounds and unique IDs, policy precedence and intent,
credential/setting identity distinctions, process-scoped keys, immutable old snapshots, backend generations, cancelled
and superseded attempts, stale-handle cleanup, hidden targets with query references, and export without runtime state.

Feature checks cover duplicate opens and pending joins, differing accounts/settings, confirmation apply/keep/cancel,
mixed startup success/failure, no user SQL/browser sign-in, preserved credential choices, invalid or unavailable
credential revisions, per-query databases and intent, migration/repeated restart/reload, cancelled dirty close,
transaction failures, active management blockers, retained results, backend loss during a prompt, popouts, and custom
documents never switching accounts. Extend existing service and Electron smoke suites rather than adding redundant
launches. Run `npm run check` before each commit and relevant Electron checks when runtime behavior changes.

README, `docs/hot-exit.md`, Object Explorer guidance, commands/options references, architecture and Unreleased notes
change with their owning feature track. Review the Connect and Run Query Getting Started guides and related samples.
The additive foundation has no user-facing behavior or guide change, so it does not claim a shipped feature in
README or CHANGELOG; the plan and architecture describe its internal contract. Do not modify frozen release records.
