# Connection roots in Object Explorer

In Connect, a single click or Space selects a saved connection for editing; Enter or a double-click connects. Object
Explorer's recovery rows offer **Retry** after a failed load, **Continue loading** after a stopped or paused one, and
**Filter** on a folder that reached its item cap.

## Disconnect, reconnect and remove

- Disconnect keeps the server at its position, collapsed and marked Disconnected; its metadata (pending loads included)
  is discarded, and Reconnect reads it afresh. Completed query results stay. Each query keeps its own SQL session, so
  reconnecting starts a fresh session without the old temporary tables, transactions or SET state.
- Connected roots offer Disconnect and Disconnect and Remove from Explorer; offline roots offer Reconnect and Remove from
  Explorer (toolbar, server menu and palette alike). Removing Explorer membership does not delete profiles, saved
  credentials or query text; a target a query references can stay hidden until explicitly reconnected.
- A server scrolled out of view keeps its full context menu on its pinned shortcut above or below the tree, and in **More
  servers**. Commands act on the server right-clicked, not the selected row or active query. Only server roots are
  pinned, not databases.

## Server order and expansion

- Drag a server row onto another to move it above or below that server (onto an expanded server, above it; onto the
  lower half of the tree's last row or below it, to move it last), or use **Move Up** and **Move Down**
  (Alt+Up and Alt+Down, also on the server's context menu). Varia announces the new position. The order is the
  connection workspace's, so it survives restarts and reloads.
- The workspace also keeps which nodes each server had expanded, as connection-free keys (at most 128 per server, 1,024
  characters each, 256 KiB in all), and what a server showed when it was lost or disconnected. Its next connect expands
  just those, or nothing if it showed none. A server with no saved expansion (first connected this run, or never shown
  connected before) expands to its folders. After updating from a version without this, servers start collapsed.
  Collapsing a node, Collapse All or Stop while a restore is still loading ends it.

## Sessions and authentication

- Connect retry settings apply to initial attempts. Once connected, idle-session recovery is off so a lost session cannot
  silently authenticate under another account; an explicit reconnect opens a fresh session.
- New physical connections authenticate without borrowing an idle pooled login (SQL authentication included). Equivalent
  connections can still reuse an accepted target and its query sessions.
- Entra authentication keeps the configured Application Name for server classifiers, logon triggers and auditing.

## Reusing a target

Equivalent connections share one root only after main verifies identity: account, credentials, submitted destination,
initial database, TLS, advanced settings and execution policy. A saved profile or similar server name is not enough.
Name, color, environment and startup reconnect preference are presentation details; favorites belong only to saved
profiles.

**Save**, in Connect's footer, saves the form to History without connecting and applies its name, color, environment and
startup reconnect preference at once to every Explorer connection with the same server, database, login and settings
(Explorer, query tabs and both status bars), changing only the labels the save changed. When History aliases share those settings, only connections still showing
the saved entry's previous labels follow it. Add favorite and Register server save the same way. Cancel, Escape or the
close button asks **Save changes to *name*?** (Save, Don't Save, Cancel) when a saved entry has edits that were not saved.

Connect applies the labels the user changed in the dialog to a reused target without asking again (only those: a
connection-only environment set from the server menu stays) and saves them to History. Otherwise, choosing
different details for an existing target, such as a History entry whose labels differ from the target's, opens **Use
selected connection details?**, with Current and Selected columns of only the changed fields beside the common
destination, database and account.

| Choice | Effect |
| --- | --- |
| **Use Selected Details** | Changes the target's labels and future reconnect preference. |
| **Keep Current Details** | Selects the target unchanged. |
| **Cancel** | Returns to Connect. |

Neither reuse choice replaces an existing SQL session. If the connection or details change while the dialog is open,
choose again from its latest state.

## Attached queries

When queries are attached, Disconnect asks to keep their tabs, close query tabs or cancel.

- Closing asks about every unsaved query and transaction before disconnecting or removing any tab; explicit saves stay
  saved if a later choice is cancelled.
- Running queries need an explicit cancellation choice (completed statements may already have taken effect). An active
  restore or document Apply must finish or be stopped first.
- **Keep Tabs** retains text, dirty state, database, remembered target and available completed results. **Close Query
  Tabs** leaves custom-document drafts open.
- A query disconnected through its own command keeps its target label but is not reattached by a later server reconnect.
  Query Change Connection chooses another target or clears it.

## Dependent documents

Database Properties, Table Designer, SSIS and other dependent documents keep their drafts when disconnected. They follow
only their exact target, never another login or other connection settings merely because the server name matches. A
legacy document without an exact target binding stays unavailable after its connection is replaced; reopen it
explicitly and keep the old draft for reference.

## Automatic reconnect

Tools > Options > Environment > Connections controls startup/reload reconnect. Each connection's Custom Properties can
inherit it or choose On/Off; saved profiles keep their own preference, which a selected profile supplies to Connect (the
details confirmation still decides whether an existing target adopts it). Reset returns to the global default.

- Only servers left connected resume; an intentional Disconnect is respected. Labels restore immediately and eligible
  targets connect in the background; failures stay available for explicit Reconnect.
- Missing credentials, unavailable OS secret storage, sign-in, network, certificate and database errors do not block other
  targets. Browser sign-in stays explicit; the OS keychain may still ask to unlock. Query buffers never run automatically.
- File operations can pause the work without losing queued servers. Manual Connect takes priority; interrupted targets
  continue afterward.
- A failed Disconnect keeps the previous resume preference when the connection stays open. Temporary identity-probe
  transport failures keep their ordinary error and recovery behaviour.
- Closing pauses automatic reconnects and settles in-progress work before keeping tabs and server associations. An
  unfinished manual Connect must be finished or cancelled before closing or reloading.
- A pending details review does not block a close: after the save prompts, the final check before the session is written
  cancels it as Cancel would, so a Windows shutdown never waits on it. If that write fails and the window stays open, the
  review stays cancelled; Connect again. With hot exit on, Reload keeps its tabs before asking, so it cancels the review
  as soon as chosen, even if its confirmation is cancelled.

## Credentials

- Saved credentials use the OS-protected vault. Connection snapshots hold nonsecret settings and opaque credential
  revision references; server, database and account metadata stay readable in local session JSON under the user's file
  permissions (the workspace is not encrypted). Account or destination changes cannot silently redirect existing query
  tabs or custom drafts. See [hot exit and query tabs](hot-exit.md#connections) for restoration and storage.
- If a saved revision is rejected, entering the corrected credentials with Remember restores its eligibility after fresh
  authentication and successful storage; live-session reuse alone does not verify a rejected secret.
- Changing a login password through Varia updates the encrypted copy for connections that already remember it
  (unremembered ones stay unremembered); if storage fails, Varia warns and asks for credentials again. It also retires
  pooled sessions that could make the old password appear valid; existing query sessions stay.
- Database-management changes update the remembered initial database without moving other queries' databases or
  replacing SQL sessions.
- An uncertain or cancelled administrative outcome requires fresh authentication instead of reusing unverified settings.
