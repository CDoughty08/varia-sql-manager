# Persistence integration hooks

This track builds on foundation `5e1a258e`. Explorer owns `App.tsx`, `core/workbench.ts`, its fixture and the main reuse
coordinator. Disconnect owns the close coordinator and `services/files.ts`. The hooks below are required when the
tracks are assembled; this branch does not start a second connection orchestrator. The three foundation surfaces
retain their original APIs.

## Workbench and document creation

Pass the authoritative registry as the fifth argument of `TargetService`:

```ts
const targets = new TargetService(documents, queries, connections, files, connectionTargets)
```

Set `DocumentOptions.target` to an exact current handle resolver. `DocumentService` uses it for queries and custom
documents at creation. The resolver must check both backend handle ID and generation, as
`TargetService.targetForConnection` does; a server name, profile key or newly generated adapter target ID is insufficient.
The callback can close over the later initialized `targets` instance, since models are created after service setup.

```ts
target: connectionId => targets.targetForConnection(connectionId)
```

After a main-verified receipt has been accepted by `ConnectionService`, use
`targets.rememberConnection(info.id, targetId)` for documents already created on that exact handle, then
`targets.attachTarget(targetId, info.id)` for restored queries that still want attachment. The latter preserves each
database and the fresh-session notice. Ordinary reuse must only select the root; it must not execute SQL, create an
unrequested query, or choose an unrelated disconnected active tab. An explicit pending Execute may run only after its
own manual connection choice succeeds. `changeConnection` is the deliberate move/clear operation; query-only
Disconnect keeps remembered target/database but clears `attachWanted`.

Explorer's existing `connection.reconnect` handler must resolve the active query using
`document.targetId ?? document.connectionId`; an offline restored query has no backend handle. Explicit reconnect of a
query with `attachWanted: false` must call `targets.changeConnection(tabId, acceptedHandleId)` after acceptance to
restore its intent. Startup must never do that. Keep hidden-target pruning paused until restored documents have been
created, then pass their exact target IDs to the registry's existing reference/pruning operations.

The query presentation reads the registry through `TargetService`'s delegated store, so no additional UI store is
needed. Authoritative target details remain authoritative when a field is cleared. The default, registry-free
constructor retains the legacy custom-document adapter only until Disconnect's exact-target providers and Explorer's
registry injection are integrated; the registry path never uses that server-name fallback.

## Session capture and restore

Add `connectionTargets` to **every** `keptSession` and `restoreSession` call. Return a capture even with zero queries
when targets exist, including while query restoration is disabled. The exact hot-exit callback is:

```ts
hotExit: () => {
  if (!api.hotExit) return
  const pinnedOnly = !settings.get('environment.documents.hotExit')
  if (!pinnedOnly || documents.getSnapshot().documents.some(tab => tab.pinned)
    || connectionTargets.getSnapshot().length)
    return keptSession(documents, id => connections.get(id)?.server,
      { pinnedOnly, groups: editorGroups, connectionTargets })
}
```

Replace the old pins-only `reloadPins` body with the shared helper (the compatibility method name can remain):

```ts
if (!api.hotExit) return
return reloadSession(documents, id => connections.get(id)?.server, {
  restoreQueries: settings.get('environment.documents.hotExit'),
  recoveryId: id => recovery.copyId(id), groups: editorGroups, connectionTargets
})
```

Await `restoreSession({ ..., connectionTargets })` before allowing manual connects or starting the background pass.
Targets restore before document labels. An established live/pending registry intentionally rejects replacement by a
restore. On an empty session, the welcome query remains the existing `otherwise` callback. Restoration never resumes
monitor subscriptions or query execution.

Session v2 keeps exact query associations; strict v1 migration retains display hints only. Do not turn a legacy
server-name hint into a target or infer a target from matching current accounts/settings. Missing credential revisions
require explicit credentials.

## Startup scheduler

Construct `StartupReconnectService(connectionTargets, connectTarget, () =>
settings.get('environment.connections.autoReconnect'))`. Start it once after restore and the initial ready backend
generation. It owns only scheduling: two concurrent background attempts, one pass per generation, no timer retries.
Dispose it with the workbench; call `refresh()` after global setting changes. Per-target `inherit/on/off` uses the
existing details schema and never overrides false `resumeWanted`.

The injected `connectTarget(target, attempt)` callback belongs to Explorer's ordinary connection owner:

1. Begin a registry connect token for `attempt.generation` with credential intent `preserve`.
2. Call `api.connect` with the target's sanitized options and this context:

   ```ts
   { targetId: target.id, requestId, mode: 'background', credentialPolicy: 'preserve',
     credentialIntent: 'preserve', credential: target.credential,
     expectedPrincipal: target.expectedPrincipal }
   ```

3. Route abort to `api.cancelConnectionRequests([requestId])` and invalidate the matching token. Manual preemption uses
   `failConnect(token, 'cancelled')` to retain resume intent; explicit Stop uses `cancelConnect(target.id)` to clear it.
   Never let an older abort invalidate a newer operation.
4. Only the operation owner accepts main's `ConnectionInfo.authentication` evidence and completion. Dispose any returned
   stale/rejected unbound handle. An `in-use` handle belongs to its existing owner and must not be disposed.
5. On success attach wanted queries through `attachTarget`. Return `{credentialRejected: result.credentialRejected}`
   on failure so the scheduler suppresses queued attempts with the same profile/revision. An ambiguous refused login
   can suppress repetition while retaining ciphertext. Publish a concise per-target
   failure reason without opening dialogs. Missing account evidence must remain an ordinary failed target.

Wrap manual connects in `const foreground = startupReconnect.beginManual()` / `finally { foreground.dispose() }`.
The callback must check document/coordinator locks before attachment. Suspend final close/reload mutation against
connection completions, and revalidate the captured workspace and query associations after asynchronous checkpoint
writes, in addition to the existing text/version checks.

`KeptSession.checkpointCurrent()` provides this value check. The focused change owned by Disconnect is immediately
after `await keepSession(now.session)` succeeds and the existing `unchanged()` text check in `FileService.closeDocuments`:

```ts
if (!now.checkpointCurrent())
  throw new Error('A connection target changed while closing the window. Review the latest changes before closing it.')
```

It compares target/database/attachment/handle associations and the nonsecret workspace captured for the write. A
change keeps the window open for a fresh checkpoint; it does not silently close against stale connection intent.
The ready-to-apply owner patch is [connections-close-checkpoint.patch](patches/connections-close-checkpoint.patch).

## Main reuse seam

`ConnectContext` adds `targetId`, `mode`, `credentialPolicy`, `credential`, `expectedPrincipal` and `credentialIntent`.
Main validates these fields; `nonInteractive` is a backend-only field and is rejected from renderer options.
Background requires the prior principal and, for password modes, an exact saved revision. `ConnectionInfo` carries
main-verified `authentication`; a successful server response without a validated actual login cannot prove account
equivalence. No comparison key enters the result.

Main's authentication pins are initialized from the validated disk/reload workspace and updated only after verified
authentication. They retain no lifecycle or transport ownership. Renderer-supplied expectations cannot replace those
pins, and session writes must retain the verified identity/reference evidence rather than trust changed renderer fields.

Integrate Explorer's `ConnectionReuseCoordinator` after credential resolution in `prepareConnection` and before the
backend open. Its request takes the validated target ID, main-owned backend generation, resolved options (including
the main-injected secret), optional trusted principal evidence, expected principal, credential intent and cancellation
signal. The `open` callback validates the backend result, obtains the actual principal, then returns
`{connection, principal}`. Only the operation owner applies successful history/credential side effects through
`settleConnection`; joined/reused callers must not repeat remember/forget or ownership mutations. Return the
coordinator's accepted `targetId` with main's authentication receipt. Bind cancellation, disconnect begin/finish and
backend loss to that same coordinator. Do not use `ConnectionService` or renderer equality as the reuse authority.
After the owner prunes a target with no document references or pending/live transport, call
`connectionAuthentication.forget(targetId)` to release its main security pin. A hidden target still referenced by a
query retains its pin.

`prepareConnection` holds a background credential binding lease until `settleConnection`/cleanup. Keep its `release`
in a `finally` covering failures before a backend send too. A saved-secret rejection invalidates only that revision;
network, TLS, database, keyring and ambiguous authentication errors preserve ciphertext. Existing ordinary dialog
remember/forget behavior stays separate from explicit background preservation.

## Disconnect and validation hooks

After the coordinator has ended affected query sessions and the backend acknowledged disconnect, call
`targets.disconnectTarget(targetId, oldHandleId)`. It preserves query text/results, each database and attachment intent.
Custom-document owners resolve their own exact `targetId`; they must not substitute another same-name server/account.

The assembled workbench must extend the existing hot-exit Electron launch: with restoration On, Reload Window keeps
eligible unpinned queries as well as pins; with it Off, only pins reopen. Add target-only restart, mixed background
success/failure, no browser/user SQL, individual database, explicit query-disconnect and retained-result provenance
assertions to existing connection/hot-exit launches. Unit coverage here tests schemas/migration, atomic/quarantine,
reload parity, exact target attachment, stale generations, credential policy/revisions and silent provider behavior.

The Connect and Run Query guides have updated restoration prose; fictional samples still make no connections or SQL
requests and require no behavior change. Published release records are unchanged.
