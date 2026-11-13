# Connections integration adversarial review

The integration combines Explorer lifecycle, connection persistence/query association, and disconnect orchestration.
Three fresh reviewers examined the assembled working tree after the first complete Electron collection, separately
covering main/backend identity, renderer restoration, and disconnect/custom documents. They reviewed production paths
and asynchronous interleavings rather than treating passing tests as proof. The findings below were required to be
resolved before opening the integration PR.

## Findings and regression coverage

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| P1 | Isolated estimated plans registered one native connection twice. Each registration captured a different ownership guard, so a real Open transition was refused. | Ownership now retains one guard and promotes session classification without replacing it. A regression dispatches the actual isolated-estimate path and raises the connection's Open state event. |
| P2 | A rejected saved revision prevented the typed credential update needed to recover that same target. | Rejection blocks resolution of that saved secret, while an explicit typed update retains the prior-principal constraint and can authenticate. Tests compose state-1/state-8 rejection with recovery. |
| P2 | Actual-plan observer cleanup reopened outside the guarded factory; a cleanup identity error could replace an already-executed query's outcome. | Cleanup uses the central opener. Cleanup-only identity failures become notices; the observer is disposed and the SQL outcome is preserved. Tests cover a lost observer and changed SID. |
| P2 | Login password and initial-database mutations changed backend connection settings without updating main's comparison evidence. | Bounded authoritative receipts update main's comparison material, durable pins and exact renderer binding. Tests cover old/new credentials, database rekey, partial success, unknown outcomes, storage failure, generation loss and initial-Connect mutation races. |
| P2 | A binding mutation admitted during a pending disconnect could leave the old key reusable if closing later failed. | Mutator admission rejects closing/fenced owners. A newer confirmed binding that cannot apply also invalidates obsolete equality. Deferred-close regressions cover failed teardown and later reuse. |
| P2 | A completed password rotation followed by backend loss left the renderer with an obsolete credential reference and blocked typed recovery. | Only an explicit interactive Update Credentials request with a typed password may use main's current reference. The generation-loss regression verifies recovery, while background, preserve, empty-password, settings and principal mismatches remain rejected. |
| P2 | A successful same-password reset could retain a credential revision that mutation settlement had just rejected. | Successful continuity must publish an admissible verified reference; the regression includes disconnect and saved background reconnect after a same-password change. |
| P2 | Ordinary toolbar Connect defaulted a matching saved profile's startup preference to Inherit and overwrote its On/Off value. | Initial library hydration respects saved policy without overriding an explicit target preference, row choice, Reset or edits made during loading. Rendered-dialog tests cover these ownership cases. |
| P2 | The selected profile ID was conflated with the saved-password source ID, so Windows/MFA and SQL aliases could update another profile's policy. | Selected metadata identity travels independently from credential-source identity. Duplicate-key profile regressions preserve each alias through physical connect and live reuse. |
| P2 | Credential settlement overlapping final close could leave an obsolete revision in the checkpoint. | Main projects current pins, revalidates authentication revision around the write and immediately before close, and fences outstanding settlement/new admission. Deferred-write tests cover replacement of R1 with R2 and retry. |
| P2 | Query-only Disconnect followed by F5 proposed a connected target as a new connect operation, which the registry correctly refused. | The form makes an independent proposal carrying the exact remembered evidence; main verifies reuse, then only the requesting query reattaches and executes. A rendered-form regression exercises the live-target path. |
| P2 | New Database and Table Designer cached command eligibility before restored document handles were attached. | Providers observe document association changes. Valid drafts regain command eligibility immediately on exact manual reconnect, with no extra edit or metadata request. |

The review also led to captured-handle guards on late Activity Monitor Kill and SSIS Stop replies, and stricter
management eligibility during Disconnecting. These prevent an old operation from updating a replacement document.

## Other integration checks

- Equality includes effective transport/session settings, actual secret and verified account. Presentation, favorites
  and reconnect policy are separate. Blank SQL credentials are unkeyed until authenticated; distinct actual principals
  sharing a requested SQL login cannot be merged. Offline affinity is principal-specific and bounded in total.
- Main owns request receipts and physical cleanup. Cancelled or stale callers release their own interest; they cannot
  close a transport another accepted caller owns. Generation checks cover cleanup, disconnect and malformed proof.
- Startup waits for restored references, successfully loaded settings and a ready backend. It uses bounded silent
  attempts, preserves explicit disconnect/Stop/removal intent, runs no query buffers and resumes no custom sampling.
- Query attachment follows exact target and per-tab database/intent. Close checkpoints include target-only workspaces.
  Hidden targets retain query/custom references and are pruned only after restoration and ownership checks.
- Disconnect reviews the whole affected query set before mutation, including saves, running work and transactions.
  Cancel preserves the reviewed set; explicit saves and already-completed session changes are reported accurately.
  Completed results retain their original provenance. Custom drafts remain bound to their exact target.
- Profile startup preferences survive Save, selection, Reset, history and favorite edits without becoming connection
  identity. The real-main Electron lifecycle covers all details-dialog choices, dirty-close cancellation, retained
  results, remove/reveal, selective close, profile policy and mixed startup success/failure.

## Driver assumptions

SID evidence is collected before caller SQL on native opens, using the current security context described by
[Microsoft's SUSER_SID documentation](https://learn.microsoft.com/en-us/sql/t-sql/functions/suser-sid-transact-sql?view=sql-server-ver17).
Entra evidence is the tenant/object pair from the exact provider token accepted by the server; missing proof fails closed.

The SqlClient audit used dependency repository commit `29ce2d856cb5a9450f79ea62c0afc744fd337fde` from the installed
package. Its [pool implementation](https://github.com/dotnet/SqlClient/blob/29ce2d856cb5a9450f79ea62c0afc744fd337fde/src/Microsoft.Data.SqlClient/src/Microsoft/Data/SqlClient/ConnectionPool/WaitHandleDbConnectionPool.cs)
has pool-local authentication caches and background replenishment outside a request's execution context. Target-private
pools alone are insufficient: Varia also refuses unscoped token acquisition. Explicit initial authentication and pinned
native opens remain allowed. Recheck these assumptions when upgrading SqlClient. Idle recovery is disabled for
identity-bound native connections; the relevant driver behavior is documented in
[connection options](https://learn.microsoft.com/en-us/sql/connect/ado-net/connection-options?view=sql-server-ver17).

SQL Tools Service retains its existing separate-process SQL/Windows credential contract and unsupported Entra modes.
It does not supply the native owner's cross-open identity proof.

## Validation and limits

`npm run check` passed on the final implementation in 80.8 seconds: 2,680 offline .NET checks, 5,063 Vitest tests,
TypeScript and the production build. The 24 configuration-dependent Vitest tests were skipped.

All 31 Electron suite commands passed across the complete collection and the final connections rerun. The collection
passed 30 suites; the connections suite then passed against the final checked build in 25.0 seconds after correcting
its old expectation that editing an Explorer target also edits the saved profile. This preserves the agreed independent
metadata ownership. The suite includes the actual-main lifecycle and automatic-reconnect checks.

The details confirmation, disconnect confirmation, retained-results and mixed-startup screenshots were inspected at
1440 by 960. Dialog content and actions were readable, offline roots remained collapsed, and remembered query status
and recovery controls remained visible. Follow-up reviews verified the confirmed corrections, including typed recovery
after generation loss; no concrete P1/P2 remained in the reviewed paths.
The local environment is Windows with no live SQL Server, Kerberos test endpoint or Entra tenant configured. Offline
provider seams, actual event handlers and fake-backend Electron tests exercise the contracts; they do not substitute
for live authentication, driver/network fault or cross-platform OS-keyring validation.

Session metadata and kept query text remain local JSON under user file permissions. Remembered passwords use the
OS-protected store; no token, plaintext password or persistent password-comparison verifier is added to the workspace.
