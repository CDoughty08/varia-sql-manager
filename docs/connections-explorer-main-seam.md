# Main connection ownership

`src/main/connection-open.ts` owns connection requests from validated IPC through authenticated delivery and renderer
acceptance. It composes the credential store, `ConnectionAuthenticationGuard`, `ConnectionReuseCoordinator`, generation
guards and existing backend cancellation. The renderer owns target lifecycle, Explorer membership, document associations
and presentation. A saved profile, target UUID and backend handle identify different things.

## Authentication and equality

1. The renderer submits options and a strict `ConnectContext`: request UUID, proposed target UUID, manual/background
   mode, credential policy and, when available, the expected principal and exact remembered credential reference.
   The selected profile's metadata identity is separate from the profile supplying a remembered secret.
   Main validates existing target settings, principal, reference and explicit credential-update intent against its own
   pins. Renderer checkpoint writes cannot replace those pins.
2. Main resolves the exact saved credential revision before comparing connections. Equality includes the supplied
   secret and every effective transport/session setting, preserving meaningful case, routing and explicit timeout
   intent. Display name, color, environment, favorites and reconnect preference do not change connection identity.
   Comparison material is an opaque process-local HMAC. It never enters IPC, disk, diagnostics or logs.
3. Nonempty SQL username/password candidates may join equivalent pending work or reuse an authenticated live handle.
   Blank SQL credentials remain unkeyed until successful authentication; their authenticated key includes the stable
   principal. Missing saved background credentials still require explicit input. Post-authentication equivalence must
   match the actual principal; ambiguous live candidates authenticate independently before choosing a target. Dynamic
   accounts authenticate independently unless trusted infrastructure has already resolved their account. A requested
   username, account hint, renderer principal or display login cannot supply that proof.
4. The backend returns bounded `principalId`: a server-verified SQL/Windows `sid:<hex>` or Entra
   `entra:<tenant GUID>:<object GUID>` tied to the token used for the successful open. Main rejects missing, malformed,
   wrong-provider or changed account evidence and closes a newly opened handle. `ConnectionInfo.login` remains display
   text. Later backend opens also reject a verified principal change; external language tooling has the limitations
   documented in the architecture guide.
5. Main returns `ConnectionInfo.targetId` and `authentication` as authoritative nonsecret evidence. The first physical
   connection settles authentication and recent-history work once. Each equivalent manual caller can still explicitly
   Remember or Forget the same proven credentials; those choices do not create another transport. Background mode
   preserves the vault, uses noninteractive authentication and never starts user SQL or a browser flow.

Saved profiles keep optional `autoReconnect` metadata outside transport options and credential/equality keys. Ordinary
successful Connect records the selected preference; omitted metadata preserves the profile's current value. Reused
manual Connect changes only the exact selected profile's policy without repeating recency or transport settlement.
Background reconnect never edits profile policy. The details confirmation separately controls the open target's policy.

## Administrative binding changes

Login password and initial-database changes preserve the existing runtime sessions, so their comparison evidence must
change too. Potential binding-mutating actions use serialized main admission, fenced against connection settlement,
unacknowledged receipts and disconnect cleanup. Backend `actions.execute` returns at most 256 authoritative
`bindingChanges` with per-handle monotonic revisions and `bindingChangesComplete`, including confirmed partial success.
An initial Connect result must still have binding revision zero; a registration mutated before delivery cannot prove
that its requested settings remain current.

Main rekeys database changes using a process-local opaque credential component rather than retaining a raw password.
Confirmed password changes use the validated sensitive action input, which never appears in the receipt. Existing
remembered intent can update its encrypted credential revision; unremembered credentials stay unremembered. Storage
failure clears an obsolete reference and reports a warning. Unknown or incomplete outcomes invalidate unproven reuse
evidence while leaving accepted sessions usable; they never claim that server changes were rolled back.

`onConnectionBindingsChanged` delivers at most 200 nonsecret updates through `varia:connection-bindings-changed`:
generation, optional warning, and changes containing target ID, handle, main event revision, sanitized options and
authentication evidence. The renderer accepts only its exact current handle/generation/principal and an increasing
revision. It updates database options and credential references together, preserves document databases/drafts and
disconnect operation ownership, and invalidates older details or pending-execution snapshots. Native mutation revisions
stay between backend and main; neither comparison material nor plaintext credentials cross this event channel.

An explicit Remember/Forget chosen on Connect can finish once its authenticated atomic storage action starts, even
when cancellation races it. Cancellation does not promise storage rollback. Storage failures produce a warning; an
unverified replacement password never inherits a saved revision merely because an older ciphertext still exists.

After successful disconnect, main retains bounded process-local offline affinity for the exact resolved equality key
and principal. Selecting the same unremembered secret authenticates again and can reconnect the retained target.
Changing credentials, pruning the target, generation loss or process exit retires obsolete affinity. After restart,
unresolved secrets are not inferred equal: the renderer can propose an offline target using an exact saved revision,
and main validates it against its pin and the newly authenticated account.

## Delivery receipts and cancellation

Successful IPC delivery is a receipt. It does not make that caller the owner of a shared backend handle.

- After authenticated target/adapter adoption, the renderer calls `acceptConnectionRequest(requestId)` and awaits
  `{ accepted, retained }` before continuing its action or opening the selected-details confirmation.
- Stop, unmount, stale adoption or a rejected attempt calls `cancelConnectionRequests([requestId])`. Cancellation
  releases that caller's pending interest or delivered receipt. The physical operation is cancelled only when no
  interested caller remains. A late successful unaccepted handle is disposed by its main owner.
- An accepted caller protects the shared handle from another caller's cancellation. Acknowledgement is idempotent.
  A rejected acknowledgement with `retained: false` proves the transport was removed; the renderer may mark only that
  exact handle lost. `retained: true` or an IPC failure does not authorize invalidating another caller's connection.
- Native Connect also owns its unpublished registration: protocol cancellation, deadlines or an unencodable reply
  release that exact ID through Dropped/Unsent cleanup. Main cannot clean a handle whose reply it never received.
  Provider properties are captured before registration, and cancellation is checked before publication.
- `credentialUpdated: true` is main's narrow proof that a same-account, same-credential caller changed the remembered
  reference. The renderer may reconcile only the exact current handle's credential reference after ordinary target
  adoption checks. It does not change the established principal or destination.
- A reused receipt has the same authoritative target. The selected-details confirmation can apply presentation,
  keep existing presentation, or return to the picker. It cannot redirect document associations or dispose a shared
  handle. Registry coalescing moves exact target references; server-name matching is never a fallback.

The two new main-only IPC methods, `acceptConnectionRequest` and `pruneConnectionTargets`, use trusted sender checks,
strict UUID schemas, bounded arrays and dedicated preload methods. They do not expose generic backend access.

## Disconnect, pruning and backend loss

The disconnect coordinator completes document prompts and Close Query Tabs preflight before main fences the target
and equivalent connection key. Main closes only the current generation's handle. A failed close restores reuse;
an acknowledged close releases ownership and leaves target intent/membership to the renderer registry.

The renderer's pruning observer calls `pruneConnectionTargets(ids)` only for hidden offline targets without document
references. Main protects live and pending ownership, queues pruning behind cancellation cleanup and then removes the
unused authentication pin and offline affinity. Acceptance revokes an obsolete queued prune. Removing a root does not
delete its saved profile or credentials.

Backend generation loss invalidates old transports, pending work and process-local affinity. Cleanup is always
generation-scoped; an old handle cannot be sent into a replacement backend. Backend shutdown owns accepted transport
disposal. Main retains only the nonsecret authentication pins needed to validate explicit or silent reconnect.

## Verification

`tests/connection-open.test.ts` exercises the composed owner with real profile/vault stores and offline backend
adapters: delivery acknowledgement, cancellation after reply, shared ownership, explicit Remember/Forget, background
preservation, credential leases, account proof, offline affinity, disconnect fencing, pruning and generation loss.
`tests/connection-reuse.test.ts`, `connection-principal.test.ts`, `connection-authentication.test.ts` and
`connection-requests.test.ts` cover the underlying equality and security boundaries. Electron lifecycle checks use the
actual main/preload flow with a controlled fake backend; live SQL/Entra checks remain separately configured.
