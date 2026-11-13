# Disconnect orchestration integration

The central hooks, prompt and exact-target custom-provider adapters described below are now integrated. This document
preserves the parallel track's handoff checklist; linked patches are historical and must not be applied again.
Current user behavior is described in [connection roots](connections-explorer.md), with ownership rules in the
[architecture invariants](architecture.md). App uses one coordinator for Explorer, command and popout disconnects.

The disconnect track is committed independently of Explorer and persistence. `services/disconnect.ts` implements the
typed `DisconnectCoordinator.disconnect(targetId, mode)` seam; modes are `disconnect` and `remove-from-explorer`.
It returns a typed outcome, including cancellation, stale backend state, blockers and uncertainty. It never owns a
second connection registry. `createDisconnectCoordinator` in `services/disconnect-workbench.ts` adapts the existing
services and API. Neither module executes query buffers, authenticates or launches browser sign-in.

## Explorer owner

Create one `DisconnectPromptService` and one coordinator in the workbench. Supply the existing `connectionTargets`,
`documents`, `queries`, `files`, `longRuns` and `api`. Mount the [dialog](connections-disconnect-dialog-integration.md)
once in App. Route main-window and popout command handlers through the same coordinator. Replace App's incremental
disconnect function; do not invoke `FileService.closeMany` for this flow. Remove the blanket running-query refusal:
the coordinator asks explicitly to cancel running queries, with Keep Running/Cancel as the safe choice.

Map a command's backend handle to its durable target before invoking `disconnect`. Inspect `result.error` for
`failed`, `stale` or `blocked`, and `result.warning` for a completed disconnect that retained edited tabs. Busy and
Cancel are quiet. A failed disconnect reply may follow actual transport teardown: the warning deliberately says its
outcome may be unknown. Confirmed backend loss must still reach `markLostBefore`; never infer successful rollback.

The two remaining adapter callbacks are owned by persistence:

```ts
detached: (targetId, handle) => targets.detached(targetId, handle),
closeQueries: plan => files.closeDisconnectedQueries(plan,
  approved => documents.closeDisconnectedQueries(approved))
```

The provided [DocumentService patch](connections-disconnect-document-service.patch) adds the synchronous local-close
hook and provider identity delegation without editing the parallel owner's source. Apply or port it before wiring
the adapter. `FileService.closeDisconnectedQueries` checks the complete reviewed version set before local removal,
uses normal `documents.closed` events for results release, then releases unclaimed file registrations. It makes no
session RPC after the server has disconnected. Do not replace it with a loop over asynchronous `documents.close`.

Run the integrated connection/files/popout Electron checks after applying the central hooks, and add a smoke case
that chooses Keep Tabs and Close Query Tabs, cancels a later dirty prompt, retains completed results, and edits a
query during disconnect. This track's unmounted dialog is covered through its service and DOM tests.

## Persistence owner

`DisconnectWorkbenchOptions.detached(targetId, handle)` must synchronously detach **only** documents belonging to
that durable target and the completed old transport generation. It clears runtime `connectionId`/session metadata
while retaining the exact `targetId`, each database, text, dirty state, per-query attachment intent, and completed
results. Server disconnect leaves attachment intent available for an explicit server reconnect; query-only
disconnect separately clears `attachWanted`. Custom drafts always stay open. Stop live/search/peek work, invalidate
pending metadata replies, and leave refresh/apply unavailable until the exact target reconnects. The compatibility
connection adapter must reflect the registry's disconnected state without deleting the target or its root.

Live subscriptions stop when their document owner's runtime connection ID becomes undefined. Publish that detach
before or with the compatibility connection change so its owner listener runs; durable target IDs stay present.
Peek's `detach()` explicitly cancels its reads. Single-target Search Objects must invalidate its pending search on
loss/removal, alongside All Servers fanout teardown; a late old-handle reply cannot populate retained documents.

`QueryService.prepareSessions('disconnect', ids)` collects choices without cancellation. Only
`cancelPreparedSessions(plan)` applies approved cancellation and requires actual execution completion; a cancellation
acknowledgement is insufficient. `PreparedSessions.current()` rejects moved/re-executed queries and changed backend
generations. The coordinator ends every selected transaction before teardown. A failed later transaction preserves
all tabs and reports the sessions that already ended. No further user cancellation prompt opens after mutation starts.

The coordinator repeatedly checks exact document associations, names, databases, dirty state and content revisions,
the target operation and backend generation, and existing management blockers. Save preflight may update saved file
names and dirty state; explicit saves remain saved if another choice cancels. Changes after transport teardown retain
every query tab and produce a warning instead of partially closing the approved set.

`QueryState.provenance` records the execution's original connection ID, generation, database and query ID (plus
`targetId` when the connection adapter supplies it). Preserve this immutable metadata with retained output; never
rewrite it on reconnect. Current session badges use `QueryState.session`, which is cleared independently. No result
rows or transaction state are persisted.

See [custom provider requirements](connections-disconnect-custom-integration.md) for the optional `targetIdOf`
resolver and explicit `canFollowTarget` delegation. Server-name-only fallback is refused. Legacy documents without a
durable binding remain unavailable after a handle replacement and may be explicitly reopened while their drafts stay.

## Documentation impact

README, Unreleased, the connection roots page and hot-exit guidance describe the integrated lifecycle. The Getting
Started Connect and Run Query guides include remembered-target restoration. Fictional samples remain inert and make
no connections or SQL requests. Existing published release records are unchanged.
