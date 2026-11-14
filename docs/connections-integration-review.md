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

The follow-up driver audit also traced [Close's wait for a pending Open](https://github.com/dotnet/SqlClient/blob/29ce2d856cb5a9450f79ea62c0afc744fd337fde/src/Microsoft.Data.SqlClient/src/Microsoft/Data/SqlClient/SqlConnection.cs#L1378)
and the [before-command diagnostic callback](https://github.com/dotnet/SqlClient/blob/29ce2d856cb5a9450f79ea62c0afc744fd337fde/src/Microsoft.Data.SqlClient/src/Microsoft/Data/SqlClient/Diagnostics/SqlDiagnosticListener.cs#L86).
Varia refuses a library reopen synchronously, permanently fences commands on that instance, and disposes it after the
callback unwinds. The diagnostic subscription is initialized synchronously once. Real-driver checks hold physical
cleanup open and verify scalar, reader, nonquery and SMO calls still fail before SQL can be sent.

## Follow-up review: sticky menus and CI

The PR's first CI run passed checks on Linux, Windows and macOS, all Windows smoke shards and Linux benchmarks. Live
SQL groups and three Linux smoke scenarios exposed additional gaps. Fresh reviewers separately audited the entire
main/renderer lifecycle, Explorer/menu behavior and backend identity/binding paths, then checked the corrections again.

| Area | Finding and correction |
| --- | --- |
| Sticky Explorer menus | Top/bottom server shortcuts and both overflow lists lacked canonical menu registration. They now resolve the same full menu and current lifecycle state as the ordinary server row, independently of the selected row. Pointer and keyboard regressions cover command target, enablement, scroll and focus. |
| Overflow keyboard placement | Dismissing the shortcut popover left a hidden entry as the menu anchor. A zero-size anchor falls back to its visible invoker. Unit geometry and real above/below overflow checks cover placement; pointer coordinates remain authoritative. |
| Deferred Connect focus | The scheduled Explorer transfer could override newer editor input. Only this transfer now checks the existing window registry's input revision, including input in popouts. Held-frame regressions preserve normal dialog cleanup while yielding to newer interaction. |
| Rejected native opens | Closing inside Open's state callback could wait on that same unfinished Open. Deferred disposal and an exact-instance command fence preserve refusal without self-wait; the subscription's Lazy initialization also closes a concurrent first-use readiness gap. |
| Factory/disconnect race | A factory could snapshot settings, lose its profile to Disconnect and create an owner without account proof. Missing registration/profile now fails closed at ownership and guarded Open admission; explicitly registered identity-free offline seams remain distinct. |
| Unknown administrative outcomes | Returned CONNECTION_LOST or CANCELLED values incorrectly claimed complete binding evidence. They now retain confirmed receipts but mark unreported changes incomplete. A real Stop-after-rename regression verifies that an already-applied statement cannot preserve obsolete equality. |
| Retired password pools | Idle sessions using a previous password could make a fresh Connect appear to authenticate that password after a known rotation. Affected tracked pools are retired before publishing the new binding. SQL opens preserve the exact retained pool-key text so cleanup reaches the pool actually used. A real SQL-login regression covers rejection of the old secret, acceptance of the new one and a retained query session. |
| Windows/Kerberos initial authentication | A pooled initial open could discover the account of an old physical session after ticket switching. Initial Windows opens authenticate without pooling; later guarded native opens retain the requested pooling preference. Offline checks cover both sides of that boundary. |
| Fatal profile errors | Optional metadata fallback could replace a fatal authentication error with a generic closed-connection error. Closed/broken-session SQL errors retain their original classification and details; recoverable metadata permission failures still use the fallback. |
| Resolved default database | A password-only binding update could overwrite a server-resolved default database with the empty submitted option. Receipt metadata now changes its database only for an acknowledged database mutation; reuse preserves the resolved name without changing identity options. |
| Late Connect publication | A closed session could throw while reading provider properties after its logical handle was registered, leaving a handle that main never received. All physical-session facts are captured before registration; a failed initialization publishes no handle. |
| Dropped Connect replies | Native protocol cancellation or response serialization failure could hide a successful registration from main. Connect now supplies idempotent exact-ID Dropped/Unsent cleanup. Actual protocol tests gate a successful dispatch before cancellation and exercise an oversized reply while retaining a separate accepted target. |
| Activity Monitor pool protection | Long application names were truncated differently by the factory and its own-pool name matcher. Both use one prefix/suffix rule, so Kill cannot miss the application's own pool because its name is long. Offline parity and actual session-action tests cover the boundary. |
| CI fixtures | Exact scripting command budgets include the account preflight. Intentional owned opens in native live fixtures use the central opener. Electron recovery checks use the current credential-update action and wait for exact attachment/focus. Activity Monitor retries only opening a non-mutating confirmation after a live sample changes, never the Kill action. The overview metric fixture owns a retained user query session rather than depending on an idle pool that cleanup tests can retire; its CPU, rates and user-session assertions remain unchanged. |
| Hot-exit observation | A recovery snapshot could remain pending against a dead renderer while main replaced its window, preventing the poll from observing the replacement. Each snapshot now has a bounded attempt and reselects the current window. A deterministic old-window crash-state override exercises the five-second fallback, requires a different window ID and preserves every pins, active-tab and unsaved-text assertion. Context listeners cover replacement pages; graceful quits retain their exit requirement within the shared close bound, and the unchanged suite watchdog names its phase. |

A proposed extra database-binding refresh API was investigated and retracted. Database-only mutation settlement
publishes synchronously; password and database receipt producers are disjoint, and reload projects current main pins.
The proposed delayed-publication interleaving was unreachable. No additional IPC was retained.

The similar behavior found outside this request is the hidden query/pinned-tab overflow in
`src/renderer/src/editor-groups/TabShelves.tsx`: those entries navigate to tabs but lack the visible tabs' context menu.
It remains a separate follow-up. Explorer pins represent server roots; there is no separate sticky database renderer.

The Connect guide's commands and basic sequence remain correct, so this menu-parity correction requires no guide or
fictional sample change. README, Unreleased, connection guidance and architecture document the behavior.

The follow-up review loop finished with no remaining actionable findings in the reviewed main/renderer, UI/menu and
backend scopes. The full pre-base-update check passed with 2,714 offline .NET checks and 5,075 Vitest tests; 24
configuration-dependent Vitest cases were skipped. The 178 focused native checks and actual SQL Server regressions
cover the added security boundaries. Live group 2 passed 475 checks; the other live groups' failures were resolved and
their affected suites rerun serially, including scripting, login/password pools, exact SID replacement, cancellation,
restore, own-pool protection and SSIS Stop. All 31 Electron suites then passed locally with live SQL authentication,
including sticky menu parity/placement, SQL results, live plans and hot exit. The unique temporary SQL login was removed
afterward. Cross-platform CI results are recorded in the PR; its first follow-up run passed all three platform checks,
all six Electron shards and live groups 2/3 and 3/3, and exposed only the overview fixture dependency described above.
After merging current main through `362cf04d`, the full check passed again in 96.7 seconds: 2,722 offline .NET
checks and 5,075 Vitest tests. Separate integration-impact reviews found no connection, cancellation or result-lease
issues from main's fair worker gate or thread-pool floor. The thread-pool floor preserves authentication scopes,
request ownership and Dropped/Unsent cleanup; the worker gate retains its independent CPU concurrency limit.

The next CI run, `43543130900`, passed all three platform checks, all three live SQL groups, Linux benchmarks, all 31
Linux Electron suites and 30 of 31 Windows suites. Windows hot exit reached its suite watchdog after the first
crash-recovery check; the old log did not identify which unbounded quit/relaunch await was pending. Five ordinary local repeats passed. The forced replacement
case then reproduced the stalled snapshot before the correction and passed afterward. Three corrected full hot-exit
runs passed, including two measured at 19.6 and 19.2 seconds. Both independent follow-up reviews found no assertion
weakening, unhandled late rejection, timer leak or production behavior change. The exact original CI await remains
unproven; the reproduced observer bug and the lifecycle bounds are recorded separately from that inference.
The full check after this correction passed in 87.0 seconds with 2,722 offline .NET checks and 5,075 Vitest tests,
TypeScript and the production build; the same 24 configuration-dependent Vitest cases were skipped.

One opt-in local SQL Server 2025 Windows Extended Events assertion remains a baseline limitation: its password-redaction
test fails identically on an isolated build of unchanged main `733b2917`. The login/SSIS SQL and that assertion are
unchanged. It was neither skipped nor weakened. The test records no secret values in these logs, and its scratch XE
sessions were removed. Version, OS and configuration causes have not been isolated. No real Kerberos account switch
or Entra tenant was available locally.

## Initial local validation and limits

`npm run check` passed on the initial integration in 80.8 seconds: 2,680 offline .NET checks, 5,063 Vitest tests,
TypeScript and the production build. The 24 configuration-dependent Vitest tests were skipped.

All 31 Electron suite commands passed across the complete collection and the final connections rerun. The collection
passed 30 suites; the connections suite then passed against the final checked build in 25.0 seconds after correcting
its old expectation that editing an Explorer target also edits the saved profile. This preserves the agreed independent
metadata ownership. The suite includes the actual-main lifecycle and automatic-reconnect checks.

The details confirmation, disconnect confirmation, retained-results and mixed-startup screenshots were inspected at
1440 by 960. Dialog content and actions were readable, offline roots remained collapsed, and remembered query status
and recovery controls remained visible. Follow-up reviews verified the confirmed corrections, including typed recovery
after generation loss; no concrete P1/P2 remained in the reviewed paths.
That Windows run had no live SQL Server, Kerberos test endpoint or Entra tenant configured. Offline
provider seams, actual event handlers and fake-backend Electron tests exercise the contracts; they do not substitute
for live authentication, driver/network fault or cross-platform OS-keyring validation.

Session metadata and kept query text remain local JSON under user file permissions. Remembered passwords use the
OS-protected store; no token, plaintext password or persistent password-comparison verifier is added to the workspace.
