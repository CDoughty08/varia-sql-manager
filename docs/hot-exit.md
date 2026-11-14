# Hot exit and query tabs

VS Code-style hot exit: closing Varia SQL Manager keeps the open query tabs instead of asking to save them, and the next
start reopens them. Tabs can be renamed without saving a file. Agreed with the owner on 2026-11-04 (tabs/docking
roadmap: "name tabs without saving, remembered between sessions").

## Setting

Tools › Options › Environment › Documents › **Restore open queries on startup** (`environment.documents.hotExit`), on by
default. While it is off, pinned tabs still reopen, and a close asks about unsaved changes in unpinned tabs.

## Pinned shelf

- The pin button moves a query or other text tab to its editor group's shelf above the unpinned tabs. Click it again
  to unpin the tab. Drag or use Move Left and Move Right to reorder tabs within either shelf.
- Hold Ctrl and scroll down over either shelf to add rows there. Scroll up to remove rows. **Increase Tab Stack Height**
  and **Decrease Tab Stack Height** in the tab menu and command palette do the same. A one-row shelf scrolls horizontally;
  stacked shelves list tabs outside their shown rows through **… N more**. Each shelf and editor group keeps its requested
  height with the saved layout.
- The SID badge to the right of a query name shows its SQL Server session ID as soon as execution acquires a session.
  A dash means there is no known live session. Restored queries start disconnected.
- View › Reload Window uses the same tab eligibility as a normal close: all eligible text tabs while startup restore
  is enabled, and only pinned tabs while it is disabled. Its checkpoint uses the text as the page unloads, including
  edits made while a reload is pending. Queries reopen disconnected before eligible targets reconnect.
- If the renderer crashes while reopening tabs at startup or after Reload Window, choosing Reload in the crash dialog
  retries the same checkpoint, including its unsaved text.

## What a close keeps

- Every text tab (queries, and XML, JSON and plan values opened from results), in strip order, including which are
  pinned and which one is active. Pinned tabs are first in their group's strip.
- The editor groups the kept tabs are in (docs/editor-groups.md, *Persistence*): splits, sizes, floating groups, each
  group's shown tab and requested pinned and unpinned stack heights, naming tabs by their place in the kept list.
  A single docked group is kept when its requested stack heights differ from the default one row.
- An untitled tab, or one with unsaved changes, keeps its text and unsaved state. A clean tab with a file keeps only
  its file's path and reopens by reading the file again (a file that is gone is named in a notice). An unsaved tab
  whose file is gone reopens with its text, without the file.
- A kept buffer with a file carries the disk fingerprint it was based on. With external-change detection enabled,
  saving asks before replacing newer disk contents. Older kept buffers without a fingerprint also ask before replacing an existing file.
- The tab's name, the user's rename and its line ending. Each query keeps its exact connection target, its own
  database and whether it wants to attach after that target reconnects. A query deliberately disconnected from its
  target keeps that context without attaching automatically.
- Connection targets keep their order, chosen name, color, environment, Explorer membership, sanitized connection
  settings, expected account and reconnect intent. A remembered credential is an opaque reference with a revision;
  changing a saved profile or password cannot silently redirect an older query.
- Never results, live connections, SQL session IDs, transactions, access tokens, unremembered passwords or connection strings.
- Table designers, Database Properties, monitors and other custom tabs are not kept; one with unsaved changes still
  asks. Unpinned tabs past the caps (64 tabs, 64 MB as written) are skipped, and those with unsaved changes still ask.
  If a pin cannot be kept, Varia leaves the window open and names the tab.
- Open transactions and running queries are still asked about (the connections close either way).
- If main cannot write the session, the window stays open and the banner says so; nothing is lost.

## Storage

Kept query text and nonsecret connection metadata (including server, database and account identifiers) are local JSON,
protected by the operating system's file access controls rather than whole-file encryption. Remembered passwords use
the separate OS-protected credential store; session files contain only opaque revision references. Unremembered
passwords and Entra tokens are never kept. Disabling query restoration does not remove the remembered connection
workspace; disconnect/remove actions and reconnect preferences control its lifecycle.

`<userData>/Session/session.json` (`src/main/session-store.ts`): 0700 folder and 0600 file on POSIX, atomic writes,
strict zod schemas on both the request and the file, invalid files quarantined. Each start deletes quarantined files
older than Keep AutoRecover information for, as AutoRecover's own purge does, and every interrupted write's temporary
file; with settings unreadable it deletes nothing. The next start takes it and renames it
`previous.json`, kept until that run closes. A new session replaces both, or a close with nothing to reopen deletes both. A run that
crashes after restoring leaves `previous.json`, and the next process's first page reopens it again, while AutoRecover
offers what changed since in its Recover dialog: a restore never loses text. A renderer crash after the restore is the
same: Reload in the crash dialog reopens `previous.json` (it holds the only copy of the restored text until a close keeps
the tabs again or AutoRecover's interval comes round), and a later close then keeps or asks about those tabs as usual.
A reload of the page within one process otherwise reopens only a session written since (macOS: closing the window and
opening a new one).

Version 2 keeps the nonsecret connection workspace beside the text tabs, including when there are no tabs. Version 1
sessions migrate with their server and database hints intact; the migration does not infer a target or account from
a server name. Unknown fields, secrets, duplicate target IDs and query associations to missing targets are rejected
and the file is quarantined. A failed or oversized write leaves the previous checkpoint available.
Temporary read or quarantine failures preserve the original bytes and refuse a replacement or clear until the file
can be read or safely quarantined. Reload checkpoints also keep each surviving tab's matching AutoRecover copy when
an unavailable file is omitted.

AutoRecover is unchanged: a hot-exit close counts as handling every query, so AutoRecover's copies are deleted and the
next start shows no Recover dialog.

## Windows shutdown, restart and log off

Windows ends its session without the quit that starts the close everywhere else (Electron emits no `before-quit`), so
main handles the window's `query-session-end`: it asks the page for AutoRecover's copies of every unsaved query at once
(`file.autoRecoverNow`, whatever the interval; nothing while AutoRecover is off), holds the end, and asks the page to
close as a quit does. Hot exit then keeps the tabs, or with it off the unsaved-query prompts ask, and the app quits once
the close is done, which lets Windows go on. While a prompt is open, Windows shows that Varia SQL Manager is keeping it
from ending; Cancel there leaves the app open, and Shut down anyway ends it with AutoRecover's copies kept. A critical end
does not wait, so it is not held. `session-end` (the end can no longer wait) asks once more for AutoRecover's copies.

## Connections

Reopened queries immediately show their remembered server and **Disconnected**, with their environment still visible.
The connection workspace restores before the queries. Automatic reconnect uses the global setting and each target's
override, and respects explicit Disconnect. It can restore a connection without running a query or opening browser
sign-in. Missing credentials or a required sign-in leave the target available for an explicit reconnect.

Only queries that wanted attachment to the exact successfully reconnected target attach. Each keeps its own database;
an unavailable database needs an explicit choice and never silently falls back to another one. A new SQL session has
none of the old temporary tables, SET state or transactions, so the existing session-restarted notice remains.
Queries restored from older server-only sessions retain the server hint but need an explicit connection choice.

## Rename Tab

- `document.rename`, **Rename Tab…**: the tab menu (`documentTab.context`), the palette, F2 while a tab has focus, and a
  double-click on a tab. The tab shows a text box: Enter or leaving the box keeps the name, Escape keeps the old one.
- Names are trimmed, control characters dropped, at most 128 characters (`tabNameChars`). An empty name, or the name the
  tab would have anyway, takes the rename away.
- The custom name wins wherever the tab is named (tab, close and session prompts, Save As's suggested file name). The
  file's path (or, for an untitled tab, its own name) is in the tooltip. Saving keeps the rename; the saved file's
  name becomes the name the tab returns to if the rename is taken away.
- Save As suggests `<custom name>.<extension>`, in Documents for an untitled tab and beside the file for a saved one.

## Tests

`tests/session-store.test.ts` (store, schemas, limits, Save As suggestion), `tests/hot-exit.test.ts` (rename, keeping,
close flow, restore, remembered database), `tests/close-intent.test.ts` (which session ends are held),
`tests/recovery-service.test.ts` (`file.autoRecoverNow`), and `scripts/hot-exit-smoke.mjs` (rename three ways, quit,
relaunch, crashes during and after a restore, a Windows session end).
Other smoke suites run with `VARIA_TEST_HOT_EXIT=0` (the fixture's default) so their save prompts stay.
