# Connection roots in Object Explorer

Disconnect keeps the server at its position in Explorer, collapsed and marked Disconnected. Its old metadata is
discarded, including pending loads. Reconnect reads metadata afresh. Completed query results remain available; each
query keeps its own SQL session, so reconnecting starts a fresh session rather than recovering temporary tables,
transactions or SET state.

Connected roots offer Disconnect and Disconnect and Remove from Explorer. Offline roots offer Reconnect and Remove
from Explorer. The toolbar, server menu and command palette share these commands. Removing Explorer membership does
not delete profiles, saved credentials or query text. A target referenced by a query can remain hidden until explicitly
reconnected.

Equivalent connections reuse one root only after main verifies their identity. Account, credentials, submitted
destination, initial database, TLS, advanced settings and execution policy participate in that decision. A saved
profile or a similar server name is insufficient. Name, color, environment and startup reconnect preference are
presentation details; favorites belong only to saved profiles.

Choosing different details for an existing target opens **Use selected connection details?**. Current and Selected
columns show only changed fields beside the common destination, database and account. **Use Selected Details** changes
the target's labels and future reconnect preference. **Keep Current Details** selects it without changing those
details. **Cancel** returns to Connect. Neither reuse choice replaces an existing SQL session. If the connection or
details change while the dialog is open, choose again using its latest state.

When queries are attached, Disconnect asks whether to keep their tabs, close query tabs or cancel. Closing asks about
every unsaved query and transaction before disconnecting or removing any tab. Explicit file saves remain saved if a
later choice is cancelled. Running queries require an explicit cancellation choice; completed statements may already
have taken effect. An active restore or document Apply operation must finish or be stopped before disconnecting.

Keep Tabs retains query text, dirty state, database, remembered target and available completed results. Close Query
Tabs leaves custom-document drafts open. A query deliberately disconnected through its own command keeps its target
label but is not automatically reattached by a later server reconnect. Query Change Connection remains the explicit
way to choose another target or clear it.

Tools > Options > Environment > Connections controls automatic startup/reload reconnect. Each connection's Custom
Properties can inherit that default or choose On/Off. Only servers left connected attempt resume; an intentional
Disconnect stays respected. Startup restores labels immediately, attempts eligible targets in the background, and
leaves failures available for explicit Reconnect. Missing credentials, unavailable OS secret storage, sign-in, network,
certificate and database errors do not block unrelated targets. Browser sign-in remains explicit. OS keychain access
may still request unlock. Query buffers are never executed automatically.

Saved credentials use the existing OS-protected vault. Connection snapshots contain nonsecret settings and opaque
credential revision references. Server, database and account metadata remain readable in local session JSON under the
user's file permissions; the complete workspace is not encrypted. Account/destination changes cannot silently redirect existing query tabs or custom
drafts. See [hot exit and query tabs](hot-exit.md#connections) for restoration and local storage details.
