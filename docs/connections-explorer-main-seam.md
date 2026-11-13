# Main connection reuse integration

`src/main/connection-reuse.ts` supplies `ConnectionReuseCoordinator<T>`, the main-only owner of accepted Explorer
transports and pending connection attempts. The Persistence track owns its integration into the existing request,
authentication and credential flows. The coordinator itself adds no IPC endpoint and never starts authentication or SQL
without its caller invoking `connect`.

## Request flow

1. Keep the existing sender checks, strict request validation and request policy. Resolve the exact credential revision
   in main before calling the coordinator. Pass the resulting options, including the actual supplied/injected secret,
   through `request.options`. Do not pass a profile key, credential-binding hash, server profile name or renderer hash as
   evidence of equivalence.
2. Supply a stable proposed target UUID and main's current backend generation. A profile UUID and runtime handle are
   different identities. Main must validate an existing target's destination/settings and explicit credential-update
   intent before making this request. For reconnection, pass the target's remembered `expectedPrincipal`. The module
   rejects authenticated account changes; it cannot establish that an untrusted caller is authorized to change a target.
3. Dynamic authentication may pass `principal` only if trusted provider infrastructure already resolved that candidate
   account. A requested username, empty MFA username, renderer-supplied principal, access token or profile hint is
   insufficient. Leave it absent when the provider has not resolved the candidate: those requests authenticate
   independently, then deduplicate against accepted handles after successful account verification. SQL login/password
   candidates can join an identical pending operation before its authentication finishes.
4. Call `connect(request, open)`. Only `open` sends the backend connect request. It receives the operation's AbortSignal
   and returns `{ connection, principal }` after successful authentication, using trusted backend/provider principal
   evidence. Stamp the connection generation in main. The existing connect request ID/cancellation path must follow the
   supplied AbortSignal. Never derive this evidence from `ConnectionInfo.login` unless the backend explicitly guarantees
   it is the verified identity for that authentication mechanism.
5. Handle `connected` and `reused` through the same renderer acceptance path. Both carry the authoritative `targetId`,
   runtime `connection` and nonsecret verified `principal`. The latter does not create a second target or query session.
   The same frozen result may be returned to several joined callers. The operation owner alone performs backend
   completion/cleanup; no consumer may disconnect the returned handle merely because its own UI attempt became stale.
   Attach independently requested query sessions through the existing query service.
6. Preserve the existing history/vault outcome handling, with each caller's remember-password choice applied by its
   owning request flow. Main must enforce credential-reference preservation/update and the explicit update intent.
   Credential intent is part of pending-join compatibility; `preserve` never joins `update-credentials`. The coordinator
   does not persist credentials or mutate the saved-profile library. Updating credentials while a target is still live
   returns `busy`; complete the appropriate disconnect flow first.

The outcome can also be `cancelled`, `identity-changed`, `invalid`, `busy`, or `failed`. A `failed` outcome retains the
actual backend error for main's existing error conversion. Do not serialize the whole coordinator or forward raw
outcomes/errors without the existing response validation and secret-safe conversion. Neither comparison keys nor raw
options appear in successful outcomes. The coordinator bounds live/pending transports and callers joining one operation
to the shared target limit.

## Ownership and lifecycle

- A caller's optional AbortSignal cancels only that caller's interest. The backend operation is cancelled once no
  interested callers remain. `cancelTarget(ownerTargetId)` explicitly invalidates the operation and every join. A
  joined target's cancellation drops only its own waiter. Removing the owner target cancels the same operation, so a
  late successful handle cannot restore it. Cancellation returns promptly even if authentication ignores cancellation.
- Main must call `markLostBefore(generation)` when the backend generation advances, before processing new work. Old
  accepted handles are forgotten and old pending attempts are invalidated. Inject `dispose(connection)` using the
  handle's generation: never send an old-generation handle's cleanup into the replacement backend.
- After the disconnect coordinator's full preflight, call `beginDisconnect(handle)` immediately before sending the
  backend disconnect. This fences reuse during mutation. On the actual acknowledged outcome call
  `finishDisconnect(handle, succeeded)`: failure retains the accepted handle; success releases its ownership. Stale
  acknowledgements cannot remove a newer handle.
- `removeTarget(id)` cancels pending ownership and returns false while a live/fenced transport still belongs to that
  target. Disconnect it before removing Explorer membership. The renderer registry owns hidden membership and document
  references; this main module does not delete documents or saved profiles.
- Only the injected `dispose` callback closes unaccepted, duplicate or stale newly opened handles. A handle already
  accepted by another operation is protected, even when a cancelled backend request returns it. `cleanupFailed` hands
  actual cleanup failures to main; the hook must not throw or log credentials/connection data. An acknowledged
  disconnect remains owned by the normal disconnect request, never by a joined connect consumer.
- `dispose()` invalidates pending attempts and erases process-local comparison material. Backend shutdown owns accepted
  live transport disposal. There is no persisted equivalence key and no comparison across process generations.

The renderer owns the selected-details confirmation and final target adoption. It must use the returned authoritative
target identity, revalidate the target after its dialog, and apply/keep only presentation fields. Cancel returns to the
picker; it does not give that consumer ownership to dispose a handle another target already accepted. Reconciling two
restored unresolved targets after trusted equivalence must update their exact document associations through the
Persistence track's target service, without server-name reassociation.

## Renderer and workbench integration

- Workbench and its fixture expose `connectionTargets: ConnectionTargetService`. Pass this same instance to
  `new ConnectionService(connectionTargets)`. The adapter's adopted entries are projections; its metadata cache stores
  server facts only. The separate legacy receipt lane preserves pre-migration callers until the main flow is wired.
- Before submitting, `ConnectionService.beginConnect(options, generation, proposedTargetId?, details?)` returns a
  `ConnectionAttempt`. Keep it in the request owner. Stop/unmount calls `cancelAttempt`; failures call `failAttempt`.
  The operation exists before authentication and stale replies cannot start another operation after removal.
- The main request owner must accept the proposed UUID and immutable expected-principal/credential revision context
  through strictly validated request fields. Main returns `ConnectionInfo` extended with authoritative `targetId`
  and `authentication: ConnectionAuthentication`, using those exact property names. The renderer must not provide an
  equality key. Newly created targets use the proposed UUID. A reused live or offline target uses main's chosen UUID.
  Offline selection must itself prove the exact credentials/settings; this module's live/pending map alone does not
  establish equality with unresolved persisted targets.
- `adoptConnection(connections, info, options, details, attempt, legacyReconnectId?, rejected?)` completes that attempt.
  It retires a provisional target when main selects an existing live target. An existing offline target can receive
  the authenticated handle only if it existed at attempt start and its lifecycle, settings and membership epoch stayed
  current. A removal followed by reveal does not revive a stale attempt. Details edits do not invalidate authentication.
- `rejected` receives the registry's full completion value, including `in-use` versus an unbound `dispose` handle.
  **Main remains the cleanup owner.** App signals the originating request through `cancelConnectionRequests(requestId)`;
  the IPC owner must preserve enough request/receipt ownership to process cancellation that races a successful reply.
  It must never close the accepted handle of another joined caller. Add an explicit receipt acknowledgement/release
  endpoint if that ownership cannot be implemented through the existing request cancellation path, following all IPC
  registration rules. The legacy request handler alone does not yet provide this post-reply receipt protocol.
- `finishConnectionDetails` revalidates target ID, handle, generation, connected lifecycle, membership and the details
  shown in the dialog before apply/keep. Cancel mutates no presentation details. Connect remains mounted but inert
  behind the confirmation, so Cancel preserves the picker draft and returns focus.
- Install the Disconnect track's coordinator as `workbench.disconnectCoordinator`, with
  `disconnect(targetId, 'disconnect' | 'remove-from-explorer')`. App prefers that hook for adopted targets and reports
  its error/warning outcome. Add that track's prompt service/dialog and full host adapter in workbench; App's legacy
  transaction path remains solely for pre-migration compatibility. It does not implement Close Query Tabs preflight.
- Persistence's `TargetService` must associate new queries with the exact target and use `attachTarget(targetId,
  handleId)` after successful reconnect, honoring each query's `attachWanted` and database. App currently preserves
  its runtime-handle `retarget(oldId, newId)` bridge until those fields/hooks are merged. Replace that bridge during
  integration; never fall back to server-name reassociation. Startup reconnect uses the same registry/adapter but never
  the details dialog, query creation, pending Execute flow or browser sign-in.

The pre-migration explicit reconnect bridge replaces legacy handles as the application did before this track. Remove
that lane once every connect caller supplies authenticated target receipts; it cannot prove credential-sensitive
equivalence and must not become the final deduplication implementation.

## Verification

`tests/connection-reuse.test.ts` covers exact pending joins, live reuse, credential/database/TLS/advanced differences,
dynamic accounts, account changes, credential intent, cancellation/removal/replacement, generation loss, disconnect
fences, accepted-handle protection, cleanup races and failure reporting. It invokes no real authentication, browser,
SQL, profile storage or secret storage. Existing integration smoke suites should cover the request owner once wired.
