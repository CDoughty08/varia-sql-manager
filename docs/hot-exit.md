# Hot exit and query tabs

VS Code-style hot exit: closing Varia SQL Manager keeps the open query tabs instead of asking to save them, and the next
start reopens them. Tabs can be renamed without saving a file.

## Setting

Tools › Options › Environment › Documents › **Restore open queries on startup** (`environment.documents.hotExit`), on by
default. While off, pinned tabs still reopen, and a close asks about unsaved changes in unpinned tabs.

## Pinned shelf

- The pin button moves a query or other text tab to its editor group's shelf above the unpinned tabs; click again to
  unpin. Drag, or Move Left and Move Right, reorder within either shelf.
- Ctrl+scroll down over a shelf adds rows, up removes them; **Increase Tab Stack Height** and **Decrease Tab Stack
  Height** (tab menu, palette) do the same. A one-row shelf scrolls horizontally; taller shelves list hidden tabs under
  **… N more**. Each shelf and group keeps its requested height with the saved layout.
- A query tab's second line shows its environment and SID badge: `SID n` once execution has a session, a dash with no
  known live session, and **Disconnected** with the server name for a restored query. Restored queries start
  disconnected.
- View › Reload Window keeps the same tabs a close would (all eligible text tabs with restore on, only pinned ones with
  it off), using the text as the page unloads, edits made during a pending reload included. Queries reopen disconnected
  before eligible targets reconnect.
- If the renderer crashes while reopening tabs (at startup or after Reload Window), Reload in the crash dialog retries
  the same checkpoint, unsaved text included.

## What a close keeps

- Every text tab (queries, and XML, JSON and plan values opened from results) in strip order, with which are pinned
  (first in their group) and which is active.
- The editor groups of the kept tabs (docs/editor-groups.md, *Persistence*): splits, sizes, floating groups, each group's
  shown tab and requested pinned and unpinned stack heights. A single docked group is kept when its stack heights differ
  from the default one row.
- Untitled or unsaved tabs keep their text and unsaved state. A clean tab with a file keeps only the path and rereads it
  (a missing file is named in a notice). An unsaved tab whose file is gone reopens with its text, without the file.
- A kept buffer with a file carries the disk fingerprint it was based on; with external-change detection on, saving asks
  before replacing newer disk contents. Kept buffers without a fingerprint also ask before replacing an existing file.
- The tab's name, rename and line ending. Each query keeps its exact connection target, its database and whether it wants
  to attach after that target reconnects; a query deliberately disconnected keeps its context without attaching.
- Connection targets keep their order, name, color, environment, Explorer membership, sanitized settings, expected
  account and reconnect intent. A remembered credential is an opaque reference with a revision, so changing a saved
  profile or password cannot silently redirect an older query.

Never kept: results, live connections, SQL session IDs, transactions, access tokens, unremembered passwords or connection
strings.

- Table designers, Database Properties, monitors and other custom tabs are not kept; one with unsaved changes still asks.
- Unpinned tabs past the caps (64 tabs, 64 MB as written) are skipped, and unsaved ones among them ask. If a pin cannot be
  kept, the window stays open and names the tab.
- Open transactions and running queries still ask (the connections close either way).
- If main cannot write the session, the window stays open and the banner says so; nothing is lost.

## Storage

Kept text and nonsecret connection metadata (server, database and account identifiers included) are local JSON protected
by OS file access controls, not encrypted. Remembered passwords use the OS-protected credential store; session files hold
only opaque revision references. Unremembered passwords and Entra tokens are never kept. Turning restore off does not
remove the connection workspace; disconnect/remove actions and reconnect preferences govern it.

`<userData>/Session/session.json` (`src/main/session-store.ts`): 0700 folder and 0600 file on POSIX, atomic writes, strict
zod schemas on request and file, invalid files quarantined.

- **Housekeeping.** Each start deletes quarantined files older than Keep AutoRecover information for, and every
  interrupted write's temporary file; with settings unreadable it deletes nothing.
- **Take and keep.** The next start takes the file and renames it `previous.json`, kept until that run closes. A new
  session replaces both; a close with nothing to reopen deletes both.
- **Crashes.** A run that crashes after restoring leaves `previous.json`, which the next process's first page reopens,
  while AutoRecover offers later changes in its Recover dialog. A renderer crash after the restore is the same: Reload
  reopens `previous.json` (the only copy of the restored text until a close keeps the tabs or AutoRecover's interval
  comes round).
- **Reloads.** Within one process a reload otherwise reopens only a session written since (macOS: closing the window and
  opening a new one). A close that kept the session and was then cancelled (an edit while writing, a failed close) moves
  its file to `previous.json`, so a reload does not reopen tabs closed since while the next start still has it.
- **Format.** Version 2 keeps the nonsecret connection workspace beside the tabs, even with no tabs. Version 1 sessions
  migrate with server and database hints intact, without inferring a target or account. Unknown fields, secrets,
  duplicate target IDs and associations to missing targets are rejected and the file quarantined.
- **Failures.** A failed or oversized write leaves the previous checkpoint. Temporary read or quarantine failures keep the
  original bytes and refuse a replacement or clear until it can be read or quarantined. If a start took the session but
  never finished reopening it, that run's first close sets `session.json` and `previous.json` aside as quarantined copies
  dated then, kept for the full Keep AutoRecover information for. Reload checkpoints keep each surviving tab's matching
  AutoRecover copy when an unavailable file is omitted.

AutoRecover is unchanged: a hot-exit close counts as handling every query, so its copies are deleted and the next start
shows no Recover dialog.

## Windows shutdown, restart and log off

Windows ends its session without a quit (Electron emits no `before-quit`), so main handles the window's
`query-session-end`: it asks the page for AutoRecover copies of every unsaved query at once (`file.autoRecoverNow`,
whatever the interval; nothing while AutoRecover is off), holds the end, and closes as a quit does. Hot exit keeps the
tabs, or with it off the unsaved-query prompts ask, and the app quits, letting Windows continue. While a prompt is open
Windows shows Varia SQL Manager blocking the end; Cancel leaves the app open, Shut down anyway ends it with AutoRecover's
copies kept. A critical end is not held. `session-end` asks once more for AutoRecover copies.

## Connections

Reopened queries show their remembered server and **Disconnected**, environment still visible. The connection workspace
restores before the queries, with each server's place in Object Explorer and the nodes it had expanded
([server order and expansion](connections-explorer.md#server-order-and-expansion)). Automatic reconnect uses the global setting and each target's override, respects explicit
Disconnect, never runs a query or opens browser sign-in. Missing credentials or a required sign-in leave the target for an
explicit reconnect.

**Sealed targets.** Windows Authentication and Microsoft Entra targets sign in without a password, so startup would send
the account's credentials before an account check could refuse them. Main seals each such target (destination, account,
Explorer membership, resume intent, labels) in `session.json` with an HMAC whose random key is protected by OS secret
storage (`src/main/connection-workspace-seal.ts`).

- A target the seal does not prove (edited or added entry, removed seal, or a seal unreadable within ten seconds this run)
  loses its remembered account and waits for an explicit Reconnect showing account and server. Tabs, labels and resume
  intent stay, so a refused Keychain prompt costs only that automatic reconnect.
- Linux: only a key the keyring holds counts; a blob under Chromium's hard-coded fallback key is refused. With no keyring
  (`basic_text`) there is no seal and the file is trusted; a locked, not-yet-running, unknown or fallback-answering keyring
  fails closed.
- The seal stops a process that can write the file but not use the OS key. It does not stop a same-user process that can
  use the key (DPAPI on Windows), or restoring an older validly sealed file; either way credentials only go to a server
  and account main verified before.
- Password targets need no seal: their saved password is bound to the server and TLS settings.

Only queries that wanted to attach to the exact reconnected target attach, each to its own database; an unavailable
database needs an explicit choice and never falls back. A new SQL session has none of the old temporary tables, SET state
or transactions, so the session-restarted notice shows. Queries from older server-only sessions keep the server hint but
need an explicit connection choice.

## Rename Tab

- `document.rename`, **Rename Tab…**: tab menu (`documentTab.context`), palette, F2 on a focused tab, or double-click a
  tab. Enter or leaving the box keeps the name; Escape keeps the old one.
- Names are trimmed, each run of control characters becomes a space, at most 128 characters (`tabNameChars`). An empty name, or the tab's
  default name, removes the rename.
- The custom name is used wherever the tab is named (tab, close and session prompts, Save As). The tooltip has the file's
  path (or an untitled tab's own name). Saving keeps the rename; the saved file's name becomes the fallback.
- Save As suggests `<custom name>.<extension>`, in Documents for an untitled tab and beside the file for a saved one.

## Tests

`tests/session-store.test.ts` (store, schemas, limits, Save As suggestion), `tests/hot-exit.test.ts` (rename, keeping,
close flow, restore, remembered database), `tests/close-intent.test.ts` (which session ends are held),
`tests/recovery-service.test.ts` (`file.autoRecoverNow`), and `scripts/hot-exit-smoke.mjs` (rename three ways, quit,
relaunch, crashes during and after a restore, a Windows session end). Other smoke suites run with `VARIA_TEST_HOT_EXIT=0`
(the fixture's default) so their save prompts stay.
