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

The Connect Getting Started guide covers reconnect and removal through live command references. The Run Query guide
and fictional samples need no content change: query execution remains explicit and samples never connect or run SQL.

This implementation track exposes the renderer adoption and disconnect hooks plus main's live/pending reuse owner.
The request/authentication, durable query associations, reconnect scheduler and disconnect preflight tracks must be
integrated before the complete planned lifecycle is shipped. Exact integration requirements are in
[the main and renderer seam](connections-explorer-main-seam.md).
